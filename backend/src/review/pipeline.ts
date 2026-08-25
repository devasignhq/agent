// Review pipeline. Spec: devasign.md §5.
//   a. Context ingestion (GitHub diff + Linear/Slack/Figma/Loom/PDF attachments)
//   b. Criteria synthesis ("End goal")
//   c. Review (multimodal LLM compares diff vs each criterion)
//   d. Output (post Check Run + PR review; write reviewLogs; broadcast)
//   e. Eval (LLM-as-judge; out-of-band, not in this hot path)
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { contributorNotifyTarget } from "../users.js";
import { dismissPRReview, dispatchWorkflow, gh, postPRCommentReturningId, updatePRComment } from "../github/app.js";
import { progressCommentBody, reviewFailedCommentBody, verdictCommentBody } from "./progress-comment.js";
import { complete, completeWithMeta, currentUsage, detectVideoProvider, summarizeLinearFile, summarizeVideo, withModel, withUsage, type VideoSummary } from "../llm.js";
import { track } from "../statsig.js";
import { broadcastVerdict } from "../integrations/broadcast.js";
import { notifyForReview, pushNotification } from "../notifications.js";
import { config } from "../config.js";
import { isObviouslyNonPublicHost } from "../ssrf.js";
import { type MaintainerComment } from "../queue.js";
import {
  downloadLinearFile,
  fetchLinearIssueContext,
  isLinearHost,
  searchLinearIssues,
  type LinearIssueContext,
  type LinearIssueCandidate,
} from "../linear/client.js";
import {
  devasignDocsForChangedFiles,
  fetchDevasignDocs,
  type DevasignDoc,
  type DevasignScope,
} from "./devasign.js";
import type { Bounty, Criterion, EvidenceCode, Installation, Integration, PRReview, PRReviewStatus, RepoIndexEntry, Repository, ReviewLogEntry, ReviewLogKind, SecurityFinding, SecuritySeverity, SuggestedChange, Task, User, Vulnerability } from "../types.js";
import { normalizeSeverity, severityToLegacy } from "../security/severity.js";
import { normalizeSlug } from "../security/fingerprint.js";
import { ACTIVE_STATES as SECURITY_ACTIVE_STATES } from "../security/policy.js";
import { publishGateForPR } from "../security/gate.js";
import { resolveBountyForPR } from "../bounties/prlink.js";
import { recordBountyEvent } from "../bounties/service.js";
import { crossRepoBlocked, modelForPlan, planForUser, privateRepoBlocked } from "../billing/plans.js";
import {
  CROSS_REPO_NO_INSTALL,
  CROSS_REPO_PLAN_LOCKED,
  CROSS_REPO_STAGE_DISABLED,
  runCrossRepoStage,
} from "./cross-repo/run.js";
import { recordParityFeatures } from "./cross-repo/parity.js";
import {
  appendAddedCriteria,
  buildCriteriaSection,
  splitForComment,
  type PriorVerdict,
} from "./criteria-format.js";
import { effectiveWorkflow } from "./workflow.js";
import { buildGuidanceSection } from "./guidance.js";
import { resolveReviewEvent, withMaintainerInstructions } from "./decisions.js";
import {
  criteriaSynthesisSystemPrompt,
  reviewSystemPrompt,
  holisticSystemPrompt,
  securitySystemPrompt,
  defectsSystemPrompt,
  deferredWorkSystemPrompt,
  devasignDocsSystemPrompt,
  type CriteriaMode,
} from "./prompts.js";
import { formatRawDiff, truncateDiffAtHunkBoundary, stripGutterArtifacts } from "./diff-format.js";
import { extractJSON, repairBledProseField } from "./parse.js";

function log(reviewId: string, kind: ReviewLogKind, action: string, extra: Partial<ReviewLogEntry> = {}) {
  const entry: ReviewLogEntry = {
    id: uuid(),
    reviewId,
    kind,
    at: Date.now(),
    action,
    ...extra,
  };
  db.insert("reviewLogs", entry);
  return entry;
}

function setStatus(reviewId: string, patch: Partial<PRReview>) {
  return db.update("prReviews", (r) => r.id === reviewId, {
    ...patch,
    updatedAt: Date.now(),
  });
}

// The Statsig actor for a repo owner: the full User (richer profile) when we can
// find it, else the bare userId string, else null for an unlinked install (no
// owner to attribute the event to — callers skip tracking).
function analyticsUser(userId: string | undefined): User | string | null {
  if (!userId) return null;
  return db.find("users", (u) => u.id === userId) ?? userId;
}

// Per-finding log row. Keeps the timeline render uniform (TimelineFor branches
// on kind === "finding") and avoids extending the PRReview shape.
type FindingCategory =
  | "regression"
  | "criticalError"
  | "security"
  // A correctness/robustness bug the diff introduces, independent of whether
  // any acceptance criterion covers it (reviewDiffDefects). Blocker-severity
  // defects gate the merge — a PR whose every criterion is met can still be
  // wrong, and that was the gap this category exists to close.
  | "defect"
  // A vulnerability that already exists in a file this PR touches or depends on
  // (surfaced from the repo index's security audit). Advisory — the PR didn't
  // introduce it, so it never gates the merge.
  | "preexistingSecurity"
  // Intent-vs-implementation note on the new commits in a re-review: where the
  // delta diff doesn't match a commit message, or the new code introduces a
  // concern. Advisory — gating happens via the criteria synthesized from intent.
  | "commitIntent"
  | "consistency"
  | "deferral"
  // DEVASIGN.md findings: a convention the diff newly violates, and a
  // DEVASIGN.md statement the diff makes outdated (docs need updating).
  | "convention"
  | "docDrift"
  // Cross-repo stage: a sibling repository that this change breaks, and a
  // capability a sibling now lacks. Both advisory — forced "warn"/"nit".
  | "crossRepo"
  | "parity"
  | "suggestion";

function emitFindingLog(
  reviewId: string,
  category: Exclude<FindingCategory, "suggestion">,
  finding: {
    path?: string;
    line?: number;
    concern: string;
    severity: "blocker" | "warn" | "nit";
    securitySeverity?: SecuritySeverity;
    fixPrompt?: string;
    defectClass?: string;
    failureScenario?: string;
    suggestedChange?: SuggestedChange | null;
  }
) {
  const titleByCategory: Record<typeof category, string> = {
    regression: "Possible regression",
    criticalError: "Critical error",
    security: "Security finding",
    defect: "Bug / correctness issue",
    preexistingSecurity: "Pre-existing security issue",
    commitIntent: "New-commit review",
    consistency: "Consistency deviation",
    deferral: "Deferred / incomplete work",
    convention: "DEVASIGN.md violation",
    docDrift: "DEVASIGN.md needs updating",
    crossRepo: "Cross-repo impact",
    parity: "Feature parity gap",
  };
  log(reviewId, "finding", titleByCategory[category], {
    detail: finding.concern,
    meta: {
      category,
      severity: finding.severity,
      ...(finding.securitySeverity ? { securitySeverity: finding.securitySeverity } : {}),
      ...(finding.path ? { path: finding.path } : {}),
      ...(finding.line ? { line: finding.line } : {}),
      title: titleByCategory[category],
      body: finding.concern,
      ...(finding.defectClass ? { defectClass: finding.defectClass } : {}),
      ...(finding.failureScenario ? { failureScenario: finding.failureScenario } : {}),
      ...(finding.fixPrompt ? { fixPrompt: finding.fixPrompt } : {}),
      ...(finding.suggestedChange ? { suggestedChange: finding.suggestedChange } : {}),
    },
  });
}

function emitSuggestionLog(reviewId: string, s: ReviewSuggestion) {
  // Compose a body that includes rationale and (optionally) the proposed change
  // and codeExample so the timeline shows the same information the GitHub
  // PR body does. `patch` (structured before/after) renders as a composed diff;
  // the legacy string suggestedChange renders as-is.
  const bodyParts = [s.rationale];
  const patchDiff = s.patch ? patchToDiff(s.patch) : s.suggestedChange;
  if (patchDiff) {
    const fence = codeFence(patchDiff);
    bodyParts.push(`${fence}diff\n${patchDiff}\n${fence}`);
  }
  if (s.codeExample) {
    const fence = codeFence(s.codeExample);
    bodyParts.push(`${fence}${fenceLang(s.language)}\n${s.codeExample}\n${fence}`);
  }
  log(reviewId, "finding", s.title || "Suggested change", {
    detail: s.rationale,
    meta: {
      category: "suggestion" as FindingCategory,
      severity: s.severity ?? ("warn" as const),
      criterionId: s.criterionId,
      title: s.title,
      body: bodyParts.join("\n\n"),
      ...(s.path ? { path: s.path } : {}),
      ...(s.line ? { line: s.line } : {}),
      ...(s.patch ? { patch: s.patch } : {}),
      ...(s.suggestedChange ? { suggestedChange: s.suggestedChange } : {}),
      ...(s.fixPrompt ? { fixPrompt: s.fixPrompt } : {}),
    },
  });
}

export async function runReviewJob(reviewId: string): Promise<void> {
  const review = db.find("prReviews", (r) => r.id === reviewId);
  if (!review) throw new Error(`review ${reviewId} not found`);
  const repo = db.find("repositories", (r) => r.id === review.repoId);
  if (!repo) throw new Error(`repo ${review.repoId} not found`);
  const install = db.find("installations", (i) => i.id === repo.installationId);

  // Private-repo gate — defence-in-depth at the one chokepoint every enqueue
  // path funnels through (comment-triggered ensurePRReview, /reviews/sync,
  // rerun, the synchronize re-enqueue, maintainer-feedback re-review). The
  // `opened` webhook posts the upgrade notice and returns without a row, but
  // those other paths skip that gate, so a free/lapsed owner's private-repo PR
  // can still reach the worker. Refuse it here before any LLM or GitHub call and
  // drop the stray row + logs, so the queue matches the canonical "no review"
  // state. Unlinked installs keep their grace window (privateRepoBlocked → false).
  if (privateRepoBlocked(repo.private, install?.userId)) {
    console.log(
      `[review] skip ${review.id} — private repo ${repo.owner}/${repo.name} needs a paid plan`
    );
    db.remove("reviewLogs", (l) => l.reviewId === review.id);
    db.remove("prReviews", (r) => r.id === review.id);
    return;
  }

  // Tier the review model by the repo owner's effective plan: Free → Haiku,
  // Pro/Max → the configured frontier model. withModel scopes it to every
  // complete() call this job makes. Unlinked installs (no userId yet) keep the
  // frontier default rather than being degraded to Haiku before linking.
  const plan = install?.userId ? planForUser(install.userId) : null;
  const reviewModel = plan ? modelForPlan(plan) : config.llm.model;
  // Per-repo workflow config. Defaults reproduce prior behavior, so a repo that
  // was never customised gates exactly as before.
  const wf = effectiveWorkflow(repo);

  // Analytics: capture wall-clock start, the "new commit vs rerun on same sha"
  // signal (before the progress-comment logic below mutates it), and the actor.
  // withUsage opens a token/cost accounting scope every complete()/summarizeVideo
  // call in this job rolls into, read once for the "review completed" event.
  const t0 = Date.now();
  const startedNewCommit = review.progressCommentSha !== review.headSha;
  // Prior criteria count + last-reviewed sha captured up front (before the
  // criteria below get reassigned / the row is re-persisted): the new-commit
  // intent stage gates on "this is a re-review of a PR that already had criteria".
  const priorCriteriaCount = review.criteria.length;
  const lastReviewedSha = review.lastReviewedSha ?? null;
  const reviewUser = analyticsUser(install?.userId);

  return withModel(reviewModel, () => withUsage(async () => {
  setStatus(review.id, { status: "reviewing" });
  // Name the model tier up front: "why was this review shallow?" is
  // undiagnosable when the model choice is invisible. plan=null means the
  // install has no linked user yet (frontier default, not a Haiku downgrade).
  log(review.id, "review", "Pipeline started", {
    detail: `Review model: ${reviewModel}${plan ? ` (plan: ${plan})` : " (no linked user — frontier default)"}`,
    meta: { model: reviewModel, plan: plan ?? null },
  });

  // Surface the "review in progress" placeholder comment the moment a run starts —
  // after the private-repo gate above, so a blocked review posts nothing. One
  // comment per commit: a rerun on the SAME head sha (manual rerun, reopen) edits
  // the existing comment back to "in progress" instead of posting a duplicate;
  // only a NEW sha (push) gets a fresh comment. postGithubOutput edits this exact
  // comment into the verdict when the run finishes. The id is held locally
  // (db.update replaces the row object, so the `review` reference captured at the
  // top would go stale) and also persisted for durability. Best-effort: a
  // commenting hiccup must never abort the review.
  let progressCommentId: number | null = null;
  if (install) {
    const reusableId =
      review.progressCommentId != null && review.progressCommentSha === review.headSha
        ? review.progressCommentId
        : null;
    if (
      reusableId !== null &&
      (await updatePRComment(install.installationId, repo.owner, repo.name, reusableId, progressCommentBody()))
    ) {
      progressCommentId = reusableId;
      log(review.id, "comment", "Reset 'review in progress' comment (rerun on same commit)");
    } else {
      // No reusable comment (new sha, first run, or the old comment was deleted).
      progressCommentId = await postPRCommentReturningId(
        install.installationId,
        repo.owner,
        repo.name,
        review.prNumber,
        progressCommentBody()
      );
      if (progressCommentId !== null) {
        setStatus(review.id, { progressCommentId, progressCommentSha: review.headSha });
        log(review.id, "comment", "Posted 'review in progress' comment");
      }
    }
  }

  try {
    // Snapshot the previous run's verdict (met/evidence) per criterion before
    // anything below overwrites review.criteria. On a `synchronize` re-review
    // this is what the review step anchors on, so a criterion an earlier commit
    // already satisfied stays satisfied instead of being re-judged from scratch
    // (and possibly flipped to "unmet") when a follow-up commit is pushed.
    // Empty on a first review → every criterion evaluates fresh, as before.
    const priorVerdicts = new Map<string, PriorVerdict>(
      review.criteria.map((c) => [c.id, { met: c.met, evidence: c.evidence }])
    );

    // a. Ingest
    const context = await ingestContext(review, repo, install);
    log(review.id, "ingest", "Context ingested", {
      detail: `${context.sources.length} source(s)`,
      meta: {
        sources: context.sources.map((s) => s.kind),
        primaryIssues: context.primaryIssues,
        secondaryIssues: context.secondaryIssues,
      },
    });
    if (context.videos.length) {
      log(review.id, "ingest", "Videos summarized by Gemini", {
        detail: `${context.videos.length} video(s)`,
        meta: {
          videos: context.videos.map((v) => ({
            url: v.url,
            provider: v.provider,
            model: v.model,
            unreliable: v.unreliable,
          })),
        },
      });
    }

    // a.5 Pull the repo index slice relevant to this PR. Touched files +
    // anything that imports from them + a short manifest of the rest of the
    // repo. The holistic Opus call below uses this so the verdict reflects
    // whole-repo impact, not just the diff.
    // Always gathered (pure db reads) so the pre-existing-vuln surfacing and the
    // security backstop have touched/dependent context even when the heavy
    // holistic stage is toggled off — the reviewAgainstRepo call itself stays
    // gated on wf.stages.holistic below.
    const holistic = gatherHolisticContext(repo, context.diff);
    if (!wf.stages.holistic) {
      log(review.id, "holistic", "Whole-repo review disabled by workflow");
    } else if (holistic.entries.length || holistic.manifest.length) {
      log(review.id, "holistic", "Repo index retrieved", {
        detail: `${holistic.entries.length} entries (${holistic.touchedCount} touched, ${holistic.dependentCount} dependents)`,
        meta: {
          indexedCommit: repo.indexedCommit,
          touched: holistic.entries.slice(0, holistic.touchedCount).map((e) => e.path),
          dependents: holistic.entries.slice(holistic.touchedCount).map((e) => e.path),
        },
      });
    } else if ((repo.indexState ?? "none") === "none") {
      log(review.id, "holistic", "Repo index not yet built — skipping whole-repo check");
    }

    // b. Criteria synthesis (with task linkage if there's a matching task)
    const task = findOrCreateTask(review);
    // If the PR resolved to a Linear ticket (explicit ref or fuzzy match),
    // record the linkage on the task so the verdict step can post a Linear
    // notification, and surface it on the timeline.
    if (context.linkedLinearIssue) {
      db.update("tasks", (t) => t.id === task.id, { linkedLinearIssue: context.linkedLinearIssue });
      log(review.id, "ingest", `Linked to Linear ${context.linkedLinearIssue.identifier}`, {
        target: context.linkedLinearIssue.identifier,
        detail: context.linkedLinearIssue.url,
        meta: { linearIssueId: context.linkedLinearIssue.id },
      });
    }
    // Whether we have any authoritative source of "done" beyond the diff: a
    // linked issue (GitHub or Linear), an attached video, or a task attachment.
    // When we don't, synthesis is told it may legitimately produce zero criteria
    // instead of inventing a spec from a thin PR description.
    const hasAuthoritativeSpec = !!(
      context.primaryIssues.length ||
      context.secondaryIssues.length ||
      context.linkedLinearIssue ||
      context.videos.length ||
      task.attachments.length
    );
    let endGoal = task.endGoal;
    let criteria: Criterion[] = [];
    // Persist the bounty linkage whenever one resolves — re-reviews included —
    // so the contributor verdict endpoint and the assignee notification below
    // can find this row even if the link was first seen on a later push.
    if (context.bountyId && review.bountyId !== context.bountyId) {
      setStatus(review.id, { bountyId: context.bountyId });
      review.bountyId = context.bountyId;
    }
    if (context.bountySeedCriteria.length && review.criteria.length === 0) {
      // Bounty PR: the acceptance list was LOCKED at funding and shown to the
      // contributor as "we review against exactly this list" — use it verbatim
      // and skip synthesis entirely. Priority above the Linear seed: a bounty
      // that references a Linear-linked issue still reviews against the bounty.
      criteria = context.bountySeedCriteria.map((c) => ({ ...c, met: null, evidence: null }));
      endGoal = context.bountyEndGoal || endGoal || "";
      db.update("tasks", (t) => t.id === task.id, { endGoal });
      log(review.id, "criteria", "Criteria seeded from bounty (locked at funding)", {
        detail: endGoal,
        meta: { count: criteria.length, source: "bounty", bountyId: context.bountyId },
      });
    } else if (context.linearSeedCriteria.length && review.criteria.length === 0) {
      // Reuse the criteria DevAsign synthesized when the Linear ticket was
      // opened — keeps the PR review consistent with what the team saw on the
      // ticket and skips a redundant synthesis call.
      criteria = context.linearSeedCriteria.map((c) => ({ ...c, met: null, evidence: null }));
      endGoal = context.linearSeedEndGoal || endGoal || "";
      db.update("tasks", (t) => t.id === task.id, { endGoal });
      log(review.id, "criteria", "Criteria seeded from linked Linear ticket", {
        detail: endGoal,
        meta: {
          count: criteria.length,
          source: "linear_cache",
          linear: context.linkedLinearIssue?.identifier,
        },
      });
    } else if (!endGoal || review.criteria.length === 0) {
      const synth = await synthesizeCriteria(review, context, hasAuthoritativeSpec, wf.prompts?.criteria);
      criteria = synth.criteria;
      // Spec-less PR with no checkable claims: keep a neutral end goal so the
      // task still reads as "reviewed" (and the frontend renders it) rather
      // than "not synthesized".
      endGoal = synth.endGoal || (criteria.length === 0 ? NEUTRAL_ENDGOAL : "");
      db.update("tasks", (t) => t.id === task.id, { endGoal });
      log(
        review.id,
        "criteria",
        criteria.length ? "End goal synthesized" : "No spec — reviewing for correctness only",
        {
          detail: endGoal,
          meta: { count: criteria.length, hasAuthoritativeSpec },
        }
      );
    } else {
      criteria = review.criteria;
    }

    // b.1 If we have video summaries, let Opus reconsider the end goal in
    // light of what the video actually shows. Opus only commits an update
    // when the video reveals product-aligned information that wasn't already
    // covered by the existing goal.
    if (context.videos.length) {
      const refined = await refineGoalFromVideos({
        review,
        endGoal: endGoal || "",
        criteria,
        videos: context.videos,
      });
      if (refined.changed) {
        endGoal = refined.endGoal;
        criteria = refined.criteria;
        db.update("tasks", (t) => t.id === task.id, { endGoal });
        log(review.id, "criteria", "End goal refined from video", {
          detail: refined.rationale || endGoal,
          meta: { count: criteria.length, videoCount: context.videos.length },
        });
      } else {
        log(review.id, "criteria", "Video reviewed; end goal unchanged", {
          detail: refined.rationale || "No product-aligned additions from the video.",
          meta: { videoCount: context.videos.length },
        });
      }
      // Analytics: a review that referenced a video. Ties the video model
      // (Gemini) to the code/text model (Opus/Haiku) on the same review, so we
      // can see how often — and how reliably — the two-model path fires.
      if (reviewUser) {
        track(reviewUser, "video reviewed", {
          repo: `${repo.owner}/${repo.name}`,
          pr_number: review.prNumber,
          video_model: context.videos[0]?.model,
          review_model: reviewModel,
          providers: [...new Set(context.videos.map((v) => v.provider))].join(","),
          video_count: context.videos.length,
          unreliable_count: context.videos.filter((v) => v.unreliable).length,
          refined_goal: refined.changed,
        });
      }
    }

    // b.2 New-commit intent review. On a re-review triggered by a fresh push of
    // a PR that already has criteria, evaluate the NEW commits against their own
    // stated intent — not just the frozen original criteria. We diff only the
    // delta since the last reviewed sha, synthesize criteria for new checkable
    // promises (appended so they gate via reviewDiff below), and emit an
    // intent-vs-implementation assessment that yields fresh feedback even when the
    // original criteria are unchanged. Skipped on first reviews, same-sha reruns,
    // and when the delta can't be fetched (force-push / API failure).
    let commitIntent: CommitIntentReview | null = null;
    if (
      install &&
      shouldReviewNewCommits({ startedNewCommit, lastReviewedSha, headSha: review.headSha, priorCriteriaCount })
    ) {
      const delta = await fetchIncrementalDelta(install.installationId, repo, lastReviewedSha!, review.headSha);
      if (delta && delta.commits.length) {
        commitIntent = await reviewNewCommits({
          review,
          endGoal: endGoal || "",
          existingCriteria: criteria,
          newCommits: delta.commits,
          incrementalDiff: delta.diff,
          extra: wf.prompts?.review,
        });
        if (commitIntent.addedCriteria.length) {
          // Appended with fresh c{N} ids; prior verdicts (captured above) don't
          // cover them, so reviewDiff scores them fresh against the cumulative diff.
          criteria = appendAddedCriteria(criteria, commitIntent.addedCriteria);
        }
        for (const f of commitIntent.intentFindings) emitFindingLog(review.id, "commitIntent", f);
        log(review.id, "criteria", `Reviewed ${delta.commits.length} new commit(s) against their intent`, {
          detail: commitIntent.summary || "Assessed the new commits against their messages and the delta diff.",
          meta: {
            newCommits: delta.commits.length,
            addedCriteria: commitIntent.addedCriteria.length,
            intentFindings: commitIntent.intentFindings.length,
            base: lastReviewedSha!.slice(0, 7),
            head: review.headSha.slice(0, 7),
          },
        });
      } else {
        log(review.id, "criteria", "New-commit intent review skipped — no incremental delta", {
          detail: "Couldn't diff the new commits against the last reviewed commit (force-push or fetch failure); reviewing cumulatively.",
        });
      }
    }

    setStatus(review.id, { taskId: task.id, criteria });

    // c. Review the diff against the criteria. priorVerdicts anchors criteria an
    // earlier commit already satisfied so a follow-up commit doesn't re-fail them.
    const verdict = await reviewDiff(review, context, criteria, priorVerdicts, wf.prompts?.review);
    // Match each criterion to its verdict by NORMALIZED id (trim + lowercase).
    // The review LLM occasionally echoes ids in a different case/whitespace than
    // synthesis produced ("c1" vs "C1"); a strict === match would silently drop
    // `met`/`evidence`, dumping every criterion into the "unmet" bucket with no
    // reason. Normalizing keeps each verdict attached so the reasoning renders.
    const verdictById = new Map(
      verdict.criteria.map((vc) => [String(vc.id ?? "").trim().toLowerCase(), vc])
    );
    const filledCriteria: Criterion[] = criteria.map((c) => {
      const m = verdictById.get(String(c.id ?? "").trim().toLowerCase());
      return {
        ...c,
        met: m?.met ?? null,
        evidence: m?.evidence ?? null,
        evidenceCode: m?.evidenceCode ?? null,
        // A fix only makes sense on an unmet criterion; drop anything the
        // model attached to a met one (the prompt says met → null already).
        suggestedChange: m?.met === false ? m?.suggestedChange ?? null : null,
      };
    });
    const allMet = filledCriteria.every((c) => c.met === true);
    // Criteria an earlier commit satisfied that this diff broke — persisted and
    // rendered as "previously met, now broken" so the developer sees the
    // regression instead of it being lumped in with never-met criteria.
    const regressedCriteriaIds = splitForComment(filledCriteria, priorVerdicts).regressed.map(
      (c) => c.id
    );

    // c.1 Whole-repo review: ask Opus to check the diff against the repo index
    // for regressions, critical errors, and security flaws. Gated on the
    // holistic stage AND the index being built (a PR can land before the initial
    // walk finishes). In either gap, the criteria verdict still stands and the
    // security backstop in c.1a below keeps security covered.
    let holisticVerdict: HolisticVerdict = EMPTY_HOLISTIC;
    const holisticRan = wf.stages.holistic && (holistic.entries.length > 0 || holistic.manifest.length > 0);
    if (!holisticRan && wf.stages.holistic) {
      // The workflow-disabled case already logs at gather time; this covers the
      // other silent gap — a silently-missing stage reads as "the agent found
      // nothing repo-wide" when it never actually looked.
      log(review.id, "holistic", "Whole-repo review skipped", {
        detail:
          "The repo index has no entries yet (initial walk not finished) — the security backstop still runs on the diff.",
        meta: { reason: "index_not_built" },
      });
    }
    if (holisticRan) {
      holisticVerdict = await reviewAgainstRepo({ review, diff: context.diff, holistic, extraInstructions: wf.prompts?.holistic });
      const holisticBlocked = [
        ...holisticVerdict.regressions,
        ...holisticVerdict.criticalErrors,
        ...holisticVerdict.securityFindings,
      ].some((f) => f.severity === "blocker");
      log(
        review.id,
        "holistic",
        holisticBlocked ? "Holistic review found blockers" : "Holistic review clean",
        {
          detail: holisticVerdict.summary,
          meta: {
            regressions: holisticVerdict.regressions.length,
            criticalErrors: holisticVerdict.criticalErrors.length,
            securityFindings: holisticVerdict.securityFindings.length,
          },
        }
      );
      // Emit one log row per finding so the frontend can render a copyable
      // fix prompt next to each item. Categories let the timeline branch on
      // severity styling without re-parsing the holistic JSON.
      for (const f of holisticVerdict.regressions) emitFindingLog(review.id, "regression", f);
      for (const f of holisticVerdict.criticalErrors) emitFindingLog(review.id, "criticalError", f);
      for (const f of holisticVerdict.securityFindings) emitFindingLog(review.id, "security", f);
    }

    // c.1a Security backstop: security MUST be analyzed on every review, even
    // when the holistic stage is toggled off or the index isn't built yet —
    // otherwise the non-downgradeable security gate would be hollow (a repo
    // could silently disable security by turning holistic off). The holistic
    // pass above already owns security when it ran, so this only fires in the
    // gap, keeping security analyzed exactly once.
    if (!holisticRan && context.diff) {
      const sec = await reviewDiffSecurity({
        review,
        diff: context.diff,
        touched: holistic.entries.slice(0, holistic.touchedCount),
        // Dedicated security prompt key, falling back to the holistic prompt so
        // repos steering security via `holistic` (the only channel before the
        // `security` key existed) keep their behavior.
        extraInstructions: wf.prompts?.security ?? wf.prompts?.holistic,
      });
      holisticVerdict = {
        ...holisticVerdict,
        securityFindings: sec.securityFindings,
        summary: holisticVerdict.summary || sec.summary,
      };
      for (const f of sec.securityFindings) emitFindingLog(review.id, "security", f);
      log(
        review.id,
        "holistic",
        sec.securityFindings.some((f) => f.severity === "blocker")
          ? "Security review found blockers"
          : sec.securityFindings.length
          ? "Security review found issues"
          : "Security review clean",
        { detail: sec.summary, meta: { securityFindings: sec.securityFindings.length } }
      );
    }

    // c.1b Pre-existing vulnerabilities (advisory): active security findings
    // stored for files this PR touches or depends on (the security audit
    // agent's `securityFindings` collection). Never gates the merge — the PR
    // didn't introduce these, so blocking it would be hostile. The comment only
    // carries a pointer to the Security page; the collected findings drive
    // that pointer's counts and the in-app timeline.
    //
    // Findings are detected against the DEFAULT BRANCH, so a vuln this PR fixes
    // would otherwise be re-surfaced verbatim. Split by whether the PR modifies
    // the file: dependents (the PR doesn't touch them) keep the read-only
    // stored-findings path; touched files are re-verified against the PR head
    // so a fix is recognized — resolved ones drop, are confirmed positively,
    // and flip to "fix_ready" on the Security page. The re-verify is gated on
    // having an install + stored findings in a touched file, so a clean PR (or
    // dev with no install) pays nothing.
    const touchedEntries = holistic.entries.slice(0, holistic.touchedCount);
    const dependentEntries = holistic.entries.slice(holistic.touchedCount);
    const activeFindingsIn = (entries: RepoIndexEntry[]): SecurityFinding[] => {
      if (!entries.length) return [];
      const paths = new Set(entries.map((e) => e.path));
      return db.filter(
        "securityFindings",
        (f) => f.repoId === repo.id && paths.has(f.path) && SECURITY_ACTIVE_STATES.includes(f.state)
      );
    };
    const dependentVulns = collectPreexistingVulns(activeFindingsIn(dependentEntries));
    let touchedVulns: HolisticFinding[];
    let resolvedVulns: HolisticFinding[] = [];
    const touchedFindings = activeFindingsIn(touchedEntries);
    if (install && touchedFindings.length > 0) {
      const reverified = await reverifyTouchedPreexistingVulns({
        review,
        repo,
        install,
        findings: touchedFindings,
        extraInstructions: wf.prompts?.security ?? wf.prompts?.holistic,
      });
      touchedVulns = reverified.stillPresent;
      resolvedVulns = reverified.resolved;
    } else {
      touchedVulns = collectPreexistingVulns(touchedFindings);
    }
    // Combine and re-apply the dedupe + cap collectPreexistingVulns enforces on
    // a single source, now that three sources feed the list: stored-audit vulns
    // in touched files (re-verified), stored-audit vulns in dependents, and any
    // the holistic model itself spotted in the provided summaries (its own
    // advisory `preexistingVulns` bucket, already forced to "warn").
    const preexistingVulns = dedupeAndCapFindings(
      [...touchedVulns, ...dependentVulns, ...holisticVerdict.preexistingVulns],
      20
    );
    if (preexistingVulns.length) {
      holisticVerdict = { ...holisticVerdict, preexistingVulns };
      for (const f of preexistingVulns) emitFindingLog(review.id, "preexistingSecurity", f);
    }
    if (resolvedVulns.length) {
      // Cap the rendered list (mirrors the 20-cap on preexistingVulns) so a mass
      // refactor can't bloat the comment; the log below keeps the true total.
      holisticVerdict = { ...holisticVerdict, resolvedPreexisting: resolvedVulns.slice(0, 20) };
    }
    if (preexistingVulns.length || resolvedVulns.length) {
      log(
        review.id,
        "holistic",
        resolvedVulns.length
          ? `Re-verified pre-existing security issues against this PR — ${resolvedVulns.length} resolved, ${preexistingVulns.length} still present`
          : `Surfaced ${preexistingVulns.length} pre-existing security issue(s)`,
        {
          detail: resolvedVulns.length
            ? "Re-checked stored vulnerabilities in files this PR modifies against the PR head; resolved ones were dropped."
            : "Vulnerabilities already present in files this PR touches — advisory, not introduced by this PR.",
          meta: { preexisting: preexistingVulns.length, resolved: resolvedVulns.length },
        }
      );
    }

    // Carry the new-commit intent review (computed in b.2) into the verdict so it
    // renders in the GitHub comment. Advisory: it does NOT feed hasBlocker — any
    // gating from the new commits happens through the criteria appended above.
    if (commitIntent) {
      holisticVerdict = {
        ...holisticVerdict,
        commitIntentFindings: commitIntent.intentFindings,
        commitIntentSummary: commitIntent.summary,
      };
    }

    // c.1c General defect review. The one stage that asks "is this code correct?"
    // rather than "does it do what was promised" — every other stage judges the
    // diff against something the PR claimed. Runs on EVERY review with a diff,
    // NOT gated on the repo index: a PR landing before the index walk finishes
    // would otherwise get zero bug detection, which is the gap this closes.
    // Index summaries sharpen it when present but aren't required. Findings the
    // holistic pass already reported are dropped so nothing double-counts in the
    // gate or the comment.
    if (!wf.stages.defects) {
      log(review.id, "holistic", DEFECT_STAGE_DISABLED);
    } else if (context.diff) {
      const { defects: rawDefects, summary: defectSummary } = await reviewDiffDefects({
        review,
        diff: context.diff,
        touched: touchedEntries,
        endGoal: endGoal || "",
        criteria: filledCriteria,
        extraInstructions: wf.prompts?.defects,
      });
      const defects = dedupeAndCapFindings(rawDefects, DEFECT_FINDING_CAP, [
        ...holisticVerdict.regressions,
        ...holisticVerdict.criticalErrors,
        ...holisticVerdict.securityFindings,
      ]);
      holisticVerdict = { ...holisticVerdict, defects };
      for (const f of defects) emitFindingLog(review.id, "defect", f);
      const defectBlockers = defects.filter((f) => f.severity === "blocker").length;
      log(
        review.id,
        "holistic",
        defectBlockers
          ? `Defect review found ${defectBlockers} blocking bug(s)`
          : defects.length
          ? `Defect review found ${defects.length} issue(s)`
          : "Defect review clean",
        {
          detail:
            defectSummary ||
            (defects.length
              ? "Correctness or robustness bugs in the changed code — see findings."
              : "No correctness or robustness bugs surfaced in the changed code."),
          meta: { defects: defects.length, blockers: defectBlockers },
        }
      );
    }

    // Merge gate: only a blocker-severity finding the DIFF introduces (regression,
    // critical error, introduced security vuln, or correctness defect) flips the
    // verdict. Pre-existing vulns are deliberately excluded. hasSecurityBlocker is
    // tracked separately so verdict routing can hold REQUEST_CHANGES firm even in
    // advisory mode — defects deliberately do NOT get that treatment, so a repo on
    // advisory verdicts still only gets a COMMENT for them.
    const hasSecurityBlocker = holisticVerdict.securityFindings.some((f) => f.severity === "blocker");
    const hasBlocker = [
      ...holisticVerdict.regressions,
      ...holisticVerdict.criticalErrors,
      ...holisticVerdict.securityFindings,
      ...holisticVerdict.defects,
    ].some((f) => f.severity === "blocker");
    // Per-criterion suggestions land as findings too — same UI affordance, so
    // a user with one unmet criterion gets a copyable prompt to fix it.
    for (const s of verdict.suggestions) emitSuggestionLog(review.id, s);

    // c.2 Deferred-work detection (advisory). Mine the diff's own added comments
    // for self-admitted punts the coding agent buried instead of surfacing —
    // TODOs, stubs, "deferred to a follow-up", NotImplemented. A cheap regex
    // pre-scan gates the LLM call so a clean diff costs nothing. These findings
    // never gate the merge (forced "warn"); they exist so the author sees the
    // punt on time. Runs after both the spec'd and spec-less review paths since
    // an agent can quietly defer work regardless of whether the PR had a spec.
    const deferralCandidates = wf.stages.deferrals ? scanDeferralCandidates(context.diff) : [];
    if (deferralCandidates.length) {
      const promise = buildPromiseText(endGoal || "", filledCriteria, context);
      const deferrals = await detectDeferredWork({
        diff: context.diff,
        promise,
        candidates: deferralCandidates,
        extraInstructions: wf.prompts?.deferrals,
      });
      // Spread into a fresh object — holisticVerdict may still be the shared
      // EMPTY_HOLISTIC const (spec'd PR with no repo index), which must not be
      // mutated. formatReviewBody reads deferrals off the verdict below.
      holisticVerdict = { ...holisticVerdict, deferrals };
      for (const f of deferrals) emitFindingLog(review.id, "deferral", f);
      log(
        review.id,
        "holistic",
        deferrals.length
          ? `Found ${deferrals.length} self-admitted deferral(s)`
          : "Scanned for deferred/incomplete work — none material",
        {
          detail: deferrals.length
            ? "The diff concedes work was deferred or stubbed — see findings."
            : `${deferralCandidates.length} marker(s) scanned; none was a real scope cut.`,
          meta: { candidates: deferralCandidates.length, deferrals: deferrals.length },
        }
      );
    }

    // c.3 DEVASIGN.md guidance (advisory). Read the repo's DEVASIGN.md files at
    // every directory level and check the diff against the rules that govern the
    // files it touches: newly introduced violations surface as nit-level
    // findings, and statements the diff makes outdated surface as "docs need
    // updating". Both are nits — they never gate the merge. Skipped entirely (no
    // LLM call) when no DEVASIGN.md governs a changed file, so most repos pay
    // nothing. Wrapped so an advisory pass never fails the whole review.
    if (install && wf.stages.docs) {
      try {
        const changedPaths = [...diffFilePaths(context.diff)];
        const docs = await fetchDevasignDocs(repo, install, review.headSha);
        const scopes = devasignDocsForChangedFiles(
          docs.map((d) => d.path),
          changedPaths
        );
        if (scopes.length) {
          const devasign = await reviewAgainstDevasignDocs({
            review,
            diff: context.diff,
            docs,
            scopes,
            extraInstructions: wf.prompts?.docs,
          });
          holisticVerdict = {
            ...holisticVerdict,
            conventionFindings: devasign.conventionFindings,
            docDriftFindings: devasign.docDriftFindings,
          };
          for (const f of devasign.conventionFindings) emitFindingLog(review.id, "convention", f);
          for (const f of devasign.docDriftFindings) emitFindingLog(review.id, "docDrift", f);
          const nitCount = devasign.conventionFindings.length;
          const driftCount = devasign.docDriftFindings.length;
          log(
            review.id,
            "holistic",
            nitCount + driftCount
              ? `DEVASIGN.md: ${nitCount} nit(s), ${driftCount} doc update(s)`
              : "Checked against DEVASIGN.md — nothing new",
            {
              detail:
                nitCount + driftCount
                  ? "Newly introduced convention nits / outdated docs — see findings."
                  : `${scopes.length} DEVASIGN.md scope(s) checked; no new violations.`,
              meta: { docs: docs.length, scopes: scopes.length, nits: nitCount, docDrift: driftCount },
            }
          );
        }
      } catch (err) {
        log(review.id, "holistic", "DEVASIGN.md guidance skipped", {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Cross-repo impact + feature parity. Runs AFTER hasBlocker (:768) is already
    // decided, so it is structurally incapable of gating the merge — same reason
    // the deferred-work and DEVASIGN.md stages live down here.
    //
    // if/else-if with exported log strings rather than the docs stage's
    // `if (install && ...)`: the offline harness seeds a dangling installationId,
    // so an install-guarded shape would make every branch but "disabled"
    // untestable. Plan is enforced here and not only in the UI, because
    // `stages` is a free-editable field.
    if (!wf.stages.crossRepo) {
      log(review.id, "holistic", CROSS_REPO_STAGE_DISABLED);
    } else if (crossRepoBlocked(install?.userId)) {
      log(review.id, "holistic", CROSS_REPO_PLAN_LOCKED);
    } else if (!install) {
      log(review.id, "holistic", CROSS_REPO_NO_INSTALL);
    } else {
      try {
        const cross = await runCrossRepoStage({
          review,
          repo,
          install,
          diff: context.diff,
          extraInstructions: wf.prompts?.crossRepo,
          log: (action, extra) => log(review.id, "holistic", action, extra),
        });
        holisticVerdict = {
          ...holisticVerdict,
          crossRepoImpacts: cross.impacts,
          parityNotes: cross.parityNotes,
        };
        for (const f of cross.impacts) emitFindingLog(review.id, "crossRepo", f);
        for (const f of cross.parityNotes) emitFindingLog(review.id, "parity", f);
        recordParityFeatures({
          install,
          repo,
          review,
          features: cross.parityFeatures,
          family: cross.family,
        });
      } catch (err) {
        log(review.id, "holistic", "Cross-repo impact skipped", {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const status: PRReviewStatus = allMet && !hasBlocker ? "passed" : "changes_requested";
    setStatus(review.id, {
      criteria: filledCriteria,
      verdict: verdict.summary,
      status,
      // Persist the regressions (met by an earlier commit, broken by this diff)
      // so the GitHub comment and the in-app timeline can flag them.
      regressedCriteriaIds,
      // Snapshot the security findings this diff INTRODUCES (4-tier severity)
      // so the merge gate's "no open PR introduces a block-gated finding" rule
      // reads the row instead of re-parsing review logs.
      securityFindings: holisticVerdict.securityFindings.map((f) => ({
        ...(f.path ? { path: f.path } : {}),
        concern: f.concern,
        severity: f.securitySeverity ?? (f.severity === "blocker" ? "critical" : "medium"),
      })),
    });

    // Route the verdict to a GitHub review action. We never auto-APPROVE a PR
    // we had no acceptance criteria to verify against: a clean spec-less pass
    // posts a neutral COMMENT and (exactly once) invites the maintainer to
    // supply an end goal so a real criteria-based review can run.
    const specless = filledCriteria.length === 0;
    // Verdict routing — incl. the advisory-mode (verdict.blocking=false) downgrade
    // of REQUEST_CHANGES → COMMENT — lives in a pure helper so it's unit-tested
    // offline (decisions.test.ts). The internal `status` stays as computed; only
    // the GitHub review event is softened.
    const { event: reviewEvent, postConversationReview, includeEndGoalCTA, downgradedToComment, securityBlockerHeld } =
      resolveReviewEvent({
        status,
        specless,
        blocking: wf.verdict.blocking,
        endGoalAlreadyRequested: !!task.endGoalRequestedAt,
        hasSecurityBlocker,
      });
    if (downgradedToComment) {
      log(review.id, "verdict", "Comment-only mode — merge not blocked", {
        detail: "Workflow set to advisory: posting a COMMENT instead of REQUEST_CHANGES.",
      });
    }
    if (securityBlockerHeld) {
      log(review.id, "verdict", "Security blocker held — advisory downgrade suppressed", {
        detail: "Advisory mode would post a COMMENT, but a vulnerability this PR introduces keeps REQUEST_CHANGES firm.",
      });
    }

    const verdictAction =
      status !== "passed"
        ? "Changes requested"
        : specless
        ? "No issues found (no linked spec)"
        : "All checks met";
    log(review.id, "verdict", verdictAction, {
      detail: verdict.summary,
      meta: {
        criteriaCount: filledCriteria.length,
        specless,
        holisticBlockers: hasBlocker,
        holisticFindings:
          holisticVerdict.regressions.length +
          holisticVerdict.criticalErrors.length +
          holisticVerdict.securityFindings.length,
      },
    });
    // App notification: analysis is complete. `review` → "passed" (blue dot),
    // `blocker` → "changes_requested" (red dot). Click navigates to detail.
    const notifyTitle =
      status !== "passed"
        ? `PR #${review.prNumber} — Changes requested`
        : specless
        ? `PR #${review.prNumber} — No issues found${includeEndGoalCTA ? "; end goal requested" : ""}`
        : `PR #${review.prNumber} — All criteria met`;
    notifyForReview(
      review.id,
      status === "passed" ? "review" : "blocker",
      notifyTitle,
      `${repo.owner}/${repo.name} — ${review.prTitle}`
    );
    // Bounty PR: also tell the CONTRIBUTOR (the bounty assignee) their verdicts
    // landed — they don't get install-owner notifications. Shows in the
    // contributor app's bell with a dashboard link.
    if (review.bountyId) {
      const bounty = db.find("bounties", (b) => b.id === review.bountyId);
      const metCount = filledCriteria.filter((c) => c.met === true).length;
      if (bounty) {
        // Activity log: the review verdict is a lifecycle moment the
        // contributor's timeline shows ("DevAsign review — X of N met").
        recordBountyEvent(bounty.id, "review_completed", {
          actor: "system",
          detail: `${metCount} of ${filledCriteria.length} criteria met`,
        });
      }
      const assignee =
        bounty?.assigneeGithubId != null
          ? contributorNotifyTarget(bounty.assigneeGithubId)
          : null;
      if (bounty && assignee) {
        pushNotification(
          assignee.id,
          "bounty",
          `${bounty.code} review complete — ${metCount} of ${filledCriteria.length} criteria met`,
          `${bounty.repo}#${review.prNumber} — ${review.prTitle}`,
          { link: "/dashboard", reviewId: review.id }
        );
      }
    }

    // d. Output: GitHub Check Run + the single verdict comment (+ bodyless
    //    approval / stale-approval dismissal) + broadcast
    const { verdictPosted } = await postGithubOutput(review, repo, install, status, {
      endGoal: endGoal || "",
      criteria: filledCriteria,
      summary: verdict.summary,
      suggestions: verdict.suggestions,
      comments: verdict.comments,
      diff: context.diff,
      holistic: holisticVerdict,
      event: reviewEvent,
      postConversationReview,
      endGoalCTA: includeEndGoalCTA,
      progressCommentId,
      prior: priorVerdicts,
    });
    // The verdict comment is now written. Clear the local id so a later
    // non-critical failure (broadcastVerdict / dispatchWorkflow) can't hit the
    // catch block and overwrite the verdict with a failure banner — the GitHub
    // output phase is already done. (The row keeps its id for the record.)
    progressCommentId = null;
    // Security merge-gate check-run on this PR's head: a PR that introduces a
    // block-gated finding fails `devasign/security` immediately, alongside the
    // End-goal check. Best-effort — the review itself already landed.
    if (install) {
      const freshReview = db.find("prReviews", (r) => r.id === review.id) ?? review;
      void publishGateForPR({ repo, install, review: freshReview }).catch(() => {});
    }
    // Stamp the sha this run evaluated as the base for the NEXT push's incremental
    // delta (b.2). Done only after the GitHub output phase so a run that errored
    // earlier doesn't advance the base — the next push still diffs from the last
    // sha we actually reviewed.
    setStatus(review.id, { lastReviewedSha: review.headSha });
    // Mark the end-goal request as sent so re-reviews on later pushes don't
    // re-spam the PR conversation. The CTA lives inside the verdict comment, so
    // "sent" means that comment landed.
    if (includeEndGoalCTA && verdictPosted) {
      db.update("tasks", (t) => t.id === task.id, { endGoalRequestedAt: Date.now() });
      log(review.id, "comment", "Requested an end goal on spec-less PR");
    }
    // Linear notification: a short "we reviewed PR #N for this issue" comment on
    // the linked ticket (the full verdict stays on the PR). Idempotent per head
    // SHA so re-reviews on later pushes don't repeat it.
    const linearInt = context.linkedLinearIssue ? linearIntegrationForUser(install?.userId) : null;
    const notifyLinear = Boolean(
      context.linkedLinearIssue && linearInt && task.linearNotifiedSha !== review.headSha
    );
    await broadcastVerdict(
      review,
      repo,
      status,
      verdict.summary,
      notifyLinear && linearInt
        ? {
            linkedLinearIssue: context.linkedLinearIssue,
            linearToken: linearInt.tokens.accessToken || linearInt.tokens.apiKey || "",
            linearBearer: Boolean(linearInt.tokens.accessToken),
          }
        : {}
    );
    if (notifyLinear) {
      db.update("tasks", (t) => t.id === task.id, { linearNotifiedSha: review.headSha });
    }
    log(
      review.id,
      "comment",
      postConversationReview
        ? "Posted Check Run; updated verdict comment"
        : "Refreshed Check Run; updated verdict comment",
      {
        meta: {
          lineNotes: verdict.comments.length,
          suggestions: verdict.suggestions.length,
          event: reviewEvent,
        },
      }
    );

    // e. Optional "Run GitHub Action": dispatch the configured workflow now that
    // the verdict is posted. Gated by the per-repo workflow + runWhen condition.
    // Best-effort — a missing actions:write scope or a workflow without a
    // workflow_dispatch trigger logs a note instead of failing the review.
    if (install && wf.actions?.enabled && wf.actions.workflow && context.branch) {
      const shouldRun = wf.actions.runWhen === "always" || status === "passed";
      if (shouldRun) {
        try {
          await dispatchWorkflow(
            install.installationId,
            repo.owner,
            repo.name,
            wf.actions.workflow,
            context.branch
          );
          log(review.id, "verdict", `Dispatched GitHub Action: ${wf.actions.workflow}`, {
            detail: `ref ${context.branch}`,
            meta: { workflow: wf.actions.workflow, ref: context.branch, runWhen: wf.actions.runWhen },
          });
        } catch (err) {
          log(review.id, "verdict", "GitHub Action dispatch skipped", {
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Analytics: the agent finished a review. One event per run — pr_number +
    // is_first_review answer "every PR reviewed", head_sha + is_new_commit answer
    // "every new commit reviewed", and the model/findings/token-cost fields say
    // what the run cost and produced. Emitted after the verdict is posted so a
    // tracking hiccup can't affect the review itself.
    if (reviewUser) {
      const usage = currentUsage();
      track(reviewUser, "review completed", {
        repo: `${repo.owner}/${repo.name}`,
        pr_number: review.prNumber,
        head_sha: review.headSha,
        status,
        is_private: repo.private,
        plan: plan ?? "unlinked",
        review_model: reviewModel,
        criteria_count: filledCriteria.length,
        criteria_met: filledCriteria.filter((c) => c.met === true).length,
        regressed_count: regressedCriteriaIds.length,
        holistic_findings:
          holisticVerdict.regressions.length +
          holisticVerdict.criticalErrors.length +
          holisticVerdict.securityFindings.length,
        holistic_blockers: hasBlocker,
        defects: holisticVerdict.defects.length,
        defect_blockers: holisticVerdict.defects.filter((f) => f.severity === "blocker").length,
        deferrals: holisticVerdict.deferrals.length,
        convention_nits: holisticVerdict.conventionFindings.length,
        doc_drift: holisticVerdict.docDriftFindings.length,
        line_comments: verdict.comments.length,
        suggestions: verdict.suggestions.length,
        video_count: context.videos.length,
        is_first_review: priorVerdicts.size === 0,
        is_new_commit: startedNewCommit,
        new_commits_reviewed: !!commitIntent,
        added_criteria: commitIntent?.addedCriteria.length ?? 0,
        intent_findings: commitIntent?.intentFindings.length ?? 0,
        additions: review.additions,
        deletions: review.deletions,
        changed_files: review.changedFiles,
        duration_ms: Date.now() - t0,
        input_tokens: usage?.inputTokens ?? 0,
        output_tokens: usage?.outputTokens ?? 0,
        cache_read_tokens: usage?.cacheReadTokens ?? 0,
        est_cost_usd: usage ? Number(usage.costUsd.toFixed(4)) : 0,
      });
    }
  } catch (err) {
    console.error(`[review] ${review.id} failed:`, err);
    setStatus(review.id, { status: "errored" });
    const errMsg = err instanceof Error ? err.message : String(err);
    log(review.id, "error", "Pipeline errored", {
      detail: errMsg,
    });
    // If we posted a "review in progress" comment for this run, edit it to a
    // failure banner so it never stays stuck on "in progress". Best-effort.
    if (install && progressCommentId !== null) {
      await updatePRComment(
        install.installationId,
        repo.owner,
        repo.name,
        progressCommentId,
        reviewFailedCommentBody()
      );
    }
    // App notification: the analysis failed. `blocker` kind so the bell shows
    // a red dot — same visual weight as "changes_requested".
    notifyForReview(
      review.id,
      "blocker",
      `PR #${review.prNumber} — Review failed`,
      `${repo.owner}/${repo.name} — ${errMsg.slice(0, 140)}`
    );
    // Bounty PR: tell the CONTRIBUTOR too. notifyForReview only ever reaches the
    // install owner, and the success path's contributor notification lives inside
    // the try above — so before this, an errored run left the assignee with no
    // signal at all and a review that appeared to be running forever.
    if (review.bountyId) {
      const bounty = db.find("bounties", (b) => b.id === review.bountyId);
      const assignee =
        bounty?.assigneeGithubId != null
          ? contributorNotifyTarget(bounty.assigneeGithubId)
          : null;
      if (bounty && assignee) {
        pushNotification(
          assignee.id,
          "bounty",
          `${bounty.code} review couldn't be completed`,
          `${bounty.repo}#${review.prNumber} — we'll retry on your next push`,
          { link: "/dashboard", reviewId: review.id }
        );
      }
    }
    // Analytics: the run errored. Mirrors "review completed" so a failure shows
    // up in the same funnel rather than vanishing.
    if (reviewUser) {
      track(reviewUser, "review failed", {
        repo: `${repo.owner}/${repo.name}`,
        pr_number: review.prNumber,
        head_sha: review.headSha,
        review_model: reviewModel,
        error: errMsg.slice(0, 200),
        duration_ms: Date.now() - t0,
      });
    }
  }
  }));
}

// --- Context ingestion ---

// Exported: the bounty criteria job builds these too (bounties/criteria-context.ts).
export type IngestedSource = { kind: string; ref: string; text: string };
type Context = {
  sources: IngestedSource[];
  diff: string;
  // Newline-delimited list of the PR's commits ("<sha7> — <subject>"), with a
  // one-line preamble. Handed to the review step (not criteria synthesis) so a
  // re-review understands the diff is the cumulative result of every commit,
  // not just the latest push. Empty when the fetch is unavailable.
  commits: string;
  // Full commit messages (subject + body) for the PR, fed to criteria synthesis
  // as a fallback spec: when the PR description is thin or empty, the commit
  // messages are often the only place the author stated the intent. Distinct
  // from `commits` (subject-only narrative for the review step). Empty when the
  // fetch is unavailable.
  commitMessages: string;
  // PR head branch (pr.head.ref) — the ref a "Run GitHub Action" dispatch uses.
  branch: string;
  videos: VideoSummary[];
  primaryIssues: number[];
  secondaryIssues: number[];
  // Linear ticket resolved for this PR (explicit ref or fuzzy match), if any.
  linkedLinearIssue: { id: string; identifier: string; url: string } | null;
  // Acceptance criteria cached on the resolved Linear ticket's Task — seeds the
  // review without re-synthesizing. Empty when nothing was cached.
  linearSeedCriteria: Criterion[];
  linearSeedEndGoal: string | null;
  // The bounty this PR delivers (explicit prNumber link from the contributor's
  // submission, or a closing-keyword ref), when one exists. Its LOCKED
  // acceptance list seeds the review verbatim — the bounty page promised the
  // contributor "DevAsign reviews your PR against exactly this list", so
  // synthesis must never rewrite it. Takes priority over the Linear seed.
  bountyId: string | null;
  bountySeedCriteria: Criterion[];
  bountyEndGoal: string | null;
  // Repo-scoped guidance materials (Workflow "Ingest context" node), distilled
  // to one authoritative block and injected into the criteria + review steps.
  // Empty string when the repo has none ready.
  guidance: string;
};

async function ingestContext(
  review: PRReview,
  repo: Repository,
  install: Installation | null
): Promise<Context> {
  const sources: IngestedSource[] = [];
  let diff = "";
  let commits = "";
  let commitMessages = "";
  let prBody = "";
  let prBranch = "";
  let linkedLinearIssue: { id: string; identifier: string; url: string } | null = null;
  let linearSeedCriteria: Criterion[] = [];
  let linearSeedEndGoal: string | null = null;
  let bountyId: string | null = null;
  let bountySeedCriteria: Criterion[] = [];
  let bountyEndGoal: string | null = null;
  // Collect videos referenced anywhere — PR body, issue bodies, attachments.
  // `source` lets the log distinguish what surfaced the URL; de-duped by URL
  // before Gemini runs so a Loom embedded in both the PR and the issue is
  // only summarised once.
  const videoTargets: Array<{ url: string; note?: string; source: string }> = [];
  let primaryIssues: number[] = [];
  let secondaryIssues: number[] = [];

  if (install) {
    try {
      const pr = await gh<any>(
        install.installationId,
        `/repos/${repo.owner}/${repo.name}/pulls/${review.prNumber}`
      );
      prBody = pr.body || "";
      prBranch = pr.head?.ref || "";
      sources.push({
        kind: "github_pr",
        ref: `${repo.owner}/${repo.name}#${review.prNumber}`,
        text: `${pr.title}\n\n${prBody}`,
      });
      // Persist real diff stats from the full PR object so the queue card
      // shows accurate counts instead of zeros.
      const nextAdditions = typeof pr.additions === "number" ? pr.additions : review.additions;
      const nextDeletions = typeof pr.deletions === "number" ? pr.deletions : review.deletions;
      const nextChangedFiles = typeof pr.changed_files === "number" ? pr.changed_files : review.changedFiles;
      if (
        nextAdditions !== review.additions ||
        nextDeletions !== review.deletions ||
        nextChangedFiles !== review.changedFiles
      ) {
        db.update("prReviews", (r) => r.id === review.id, {
          additions: nextAdditions,
          deletions: nextDeletions,
          changedFiles: nextChangedFiles,
        });
        // Keep the local reference in sync for downstream logic in this call.
        review.additions = nextAdditions;
        review.deletions = nextDeletions;
        review.changedFiles = nextChangedFiles;
      }
      // Fetch unified diff
      diff = await ghText(
        install.installationId,
        `/repos/${repo.owner}/${repo.name}/pulls/${review.prNumber}`,
        { Accept: "application/vnd.github.v3.diff" }
      );
      sources.push({ kind: "diff", ref: review.headSha, text: diff.slice(0, 50_000) });

      // Commit list — so the review step knows the diff above is the cumulative
      // result of every commit in the PR (and what each did), not the latest
      // push in isolation. This is the fix for re-reviews wrongly re-failing
      // criteria that earlier commits already satisfied. Best-effort and in its
      // own try/catch: a failure here must not abort the rest of ingestion.
      // GitHub caps this endpoint at 250 commits; one page of 100 is ample
      // narrative context (the diff, not the list, is the evidence of record).
      try {
        const prCommits = await gh<Array<{ sha: string; commit: { message: string } }>>(
          install.installationId,
          `/repos/${repo.owner}/${repo.name}/pulls/${review.prNumber}/commits?per_page=100`
        );
        if (prCommits.length) {
          const total = typeof pr.commits === "number" ? pr.commits : prCommits.length;
          const lines = prCommits.map(
            (c) => `- ${c.sha.slice(0, 7)} — ${(c.commit?.message || "").split("\n")[0]}`
          );
          const preamble =
            prCommits.length < total
              ? `This PR is the cumulative result of ${total} commits (first ${prCommits.length} shown); the diff above already contains all of them:`
              : `This PR is the cumulative result of these ${prCommits.length} commit${prCommits.length === 1 ? "" : "s"}; the diff above already contains all of them:`;
          commits = `${preamble}\n${lines.join("\n")}`;
          // Full commit messages (subject + body), for criteria synthesis to fall
          // back on when the PR description is thin or empty: the commits are then
          // the clearest statement of what the change set out to do. The review
          // step uses the subject-only `commits` narrative above; this richer
          // block is synthesis-only and bounded by per-commit/total caps.
          commitMessages = formatPrCommitMessages(
            prCommits.map((c) => ({ sha: c.sha, message: c.commit?.message || "" }))
          );
        }
      } catch (err) {
        console.warn(`[ingest] commits fetch failed:`, err);
      }

      // Videos embedded directly in the PR body — same path Gemini takes for
      // attachments. The PR description is often where a Loom lives.
      for (const url of extractVideoUrls(pr.body || "")) {
        videoTargets.push({ url, note: `embedded in PR body`, source: "pr_body" });
      }

      // Linked issues — prefer the canonical "closes/fixes/resolves" keyword
      // since that's GitHub's signal for the job-to-be-done. Fall back to a
      // bare `#N` scan so we don't lose context from devs who don't follow
      // the convention.
      const { primary, secondary } = extractLinkedIssues(pr.body || "");
      primaryIssues = primary;
      secondaryIssues = secondary;
      for (const num of primary) {
        const issue = await fetchIssueSafe(install.installationId, repo, num);
        if (!issue) continue;
        sources.push({
          kind: "github_issue_primary",
          ref: `${repo.owner}/${repo.name}#${num}`,
          text: `${issue.title}\n\n${issue.body || ""}`,
        });
        for (const url of extractVideoUrls(issue.body || "")) {
          videoTargets.push({ url, note: `embedded in issue #${num}`, source: "issue_body" });
        }
      }
      for (const num of secondary) {
        const issue = await fetchIssueSafe(install.installationId, repo, num);
        if (!issue) continue;
        sources.push({
          kind: "github_issue",
          ref: `${repo.owner}/${repo.name}#${num}`,
          text: `${issue.title}\n\n${issue.body || ""}`,
        });
        for (const url of extractVideoUrls(issue.body || "")) {
          videoTargets.push({ url, note: `embedded in issue #${num}`, source: "issue_body" });
        }
      }
    } catch (err) {
      // Best-effort: in dev without a real install, we still want the pipeline to run.
      console.warn(`[ingest] github fetch failed:`, err);
    }
  }

  // Attachments the user added on the Message-agent screen
  const task = db.find("tasks", (t) => t.externalId === taskExternalId(review));
  if (task) {
    for (const a of task.attachments) {
      sources.push({
        kind: a.kind,
        ref: a.url || a.contentRef || "",
        text: a.note || (a.kind === "text" ? a.url || "" : `[${a.kind}] ${a.url || ""}`),
      });
      // Collect any video-like reference for Gemini. `loom` always counts;
      // plain `link` attachments are checked by URL host.
      const url = a.url || "";
      if (a.kind === "loom" || (a.kind === "link" && detectVideoProvider(url))) {
        videoTargets.push({ url, note: a.note, source: "attachment" });
      }
    }
  }

  // ── Linear ticket resolution ──────────────────────────────────────────────
  // If this repo's owner connected Linear, tie the PR to a Linear issue. First
  // by an explicit identifier in the PR body/branch (the "Fixes ENG-123" magic
  // words Linear's GitHub integration injects, and its `user/eng-123-slug`
  // branch names). Otherwise — whenever there's no explicit Linear ref — by a
  // conservative fuzzy search over the workspace's open issues, so an unlinked
  // PR still gets matched to its ticket. The resolved issue is the authoritative
  // spec; criteria cached when the ticket was opened seed the review so we don't
  // re-synthesize. The matcher returns null unless a candidate clearly
  // corresponds, and search failures degrade to "no match".
  const linearIntegration = linearIntegrationForUser(install?.userId);
  if (linearIntegration) {
    const token = linearIntegration.tokens.accessToken || linearIntegration.tokens.apiKey || "";
    const bearer = Boolean(linearIntegration.tokens.accessToken);
    if (token) {
      try {
        let issue: LinearIssueContext | null = null;
        const explicit = extractLinkedLinearIssues(prBody, prBranch);
        if (explicit.length) {
          issue = await fetchLinearIssueContext(token, explicit[0], { bearer });
        } else {
          const candidates = await searchLinearIssues(token, `${review.prTitle} ${prBody}`, { bearer });
          const matchId = await matchPrToLinearIssue({ prTitle: review.prTitle, prBody, candidates });
          if (matchId) issue = await fetchLinearIssueContext(token, matchId, { bearer });
        }
        if (issue) {
          linkedLinearIssue = { id: issue.id, identifier: issue.identifier, url: issue.url };
          for (const s of linearSourcesFromIssue(issue)) sources.push(s);
          // A Loom/YouTube/Vimeo in the Linear description gets the same Gemini
          // treatment as one embedded in a GitHub issue.
          for (const url of extractVideoUrls(issue.description)) {
            videoTargets.push({ url, note: `embedded in ${issue.identifier}`, source: "linear_issue" });
          }
          const cached = db.find("tasks", (t) => t.externalId === `linear:${issue!.id}`);
          if (cached?.criteria?.length) {
            // Cache hit: the criteria already reflect the ticket's files, so we
            // don't re-download/summarize them here.
            linearSeedCriteria = cached.criteria;
            linearSeedEndGoal = cached.endGoal;
          } else {
            // No cache → we'll synthesize fresh, so read any attached files now.
            for (const s of await summarizeLinearFiles(issue, token, bearer)) sources.push(s);
          }
        }
      } catch (err) {
        console.warn("[ingest] linear resolution failed:", err);
      }
    }
  }

  // De-dupe by URL so a Loom appearing in both PR body and issue body or in
  // attachments doesn't get summarised multiple times.
  const seenUrls = new Set<string>();
  const dedupedTargets = videoTargets.filter((v) => {
    if (!v.url) return false;
    if (seenUrls.has(v.url)) return false;
    seenUrls.add(v.url);
    return true;
  });

  // Hand each video to Gemini for transcription/understanding so the downstream
  // Opus reviewer can reason about what the recorded UX actually shows.
  const videos: VideoSummary[] = [];
  for (const v of dedupedTargets) {
    if (!v.url) continue;
    try {
      const s = await summarizeVideo({ url: v.url, note: v.note });
      videos.push(s);
      sources.push({
        kind: "video_summary",
        ref: v.url,
        text:
          `Source: ${v.source}\n` +
          `Provider: ${s.provider} (model: ${s.model})\n` +
          `Summary: ${s.summary}\n` +
          (s.keyMoments.length
            ? `Key moments:\n${s.keyMoments.map((k) => `  ${k.t} — ${k.note}`).join("\n")}\n`
            : "") +
          (s.acceptanceSignals.length
            ? `Acceptance signals:\n${s.acceptanceSignals.map((a) => `  - ${a}`).join("\n")}\n`
            : "") +
          (s.unreliable ? "(unreliable: model could not directly watch the video)\n" : ""),
      });
    } catch (err) {
      console.warn("[ingest] video summarize failed for", v.url, err);
    }
  }

  // The bounty this PR delivers, if any: the explicit prNumber link (set by
  // markInReview via the PR webhook or the contributor's /submit endpoint)
  // wins; otherwise a closing-keyword ref in the PR body. Only live
  // (DELEGATED/IN_REVIEW) bounties count — a paid or cancelled bounty must not
  // re-seed criteria. DB-only, so it works even when the PR fetch failed.
  const repoFullName = `${repo.owner}/${repo.name}`;
  const isLive = (b: Bounty) => b.status === "DELEGATED" || b.status === "IN_REVIEW";
  let linkedBounty =
    db.find(
      "bounties",
      (b) => b.repo === repoFullName && b.prNumber === review.prNumber && isLive(b)
    ) ?? null;
  if (!linkedBounty) {
    const byRef = resolveBountyForPR(repoFullName, prBody);
    if (byRef && isLive(byRef)) linkedBounty = byRef;
  }
  if (linkedBounty) {
    bountyId = linkedBounty.id;
    // The drafted end goal is one sentence written specifically to describe what
    // success looks like, so prefer it over the title+first-line derivation.
    // Falls back for bounties created before drafting existed, and for any whose
    // draft failed.
    bountyEndGoal =
      linkedBounty.acceptanceEndGoal?.trim() ||
      linkedBounty.title +
        (linkedBounty.description ? ` — ${linkedBounty.description.split("\n")[0]}` : "");
    // Locked acceptance list → seed criteria with stable `bounty-N` ids (the
    // prefix-tolerant id parse in appendAddedCriteria keeps later additive
    // criteria numbering intact alongside these).
    bountySeedCriteria = linkedBounty.acceptance.map((text, i) => ({
      id: `bounty-${i + 1}`,
      text,
      met: null,
      evidence: null,
    }));
  }

  // Repo-scoped guidance materials the maintainer attached on the Workflow
  // "Ingest context" node. Distilled once at add-time; injected here as one
  // authoritative block (threaded into the criteria + review prompts) and also
  // pushed as a source so it shows up in the "sources analyzed" log.
  const guidance = buildGuidanceSection(repo);
  if (guidance) {
    sources.push({ kind: "repo_guidance", ref: "repository guidance", text: guidance });
  }

  return {
    sources,
    diff,
    commits,
    commitMessages,
    branch: prBranch,
    videos,
    primaryIssues,
    secondaryIssues,
    linkedLinearIssue,
    linearSeedCriteria,
    linearSeedEndGoal,
    bountyId,
    bountySeedCriteria,
    bountyEndGoal,
    guidance,
  };
}

// Pull issues referenced from a PR body. GitHub treats the canonical
// "closes #N" family of keywords as the authoritative link (it's what auto-
// closes the issue on merge), so we surface those as primary. Bare `#N` and
// `owner/repo#N` references that didn't carry a keyword still get ingested as
// secondary context — devs are inconsistent and we don't want to lose signal.
function extractLinkedIssues(body: string): { primary: number[]; secondary: number[] } {
  const primary = new Set<number>();
  const secondary = new Set<number>();
  // Keyword form: closes #42, fixes owner/repo#42, resolved #42, etc.
  // The optional `owner/repo` prefix is allowed for cross-repo references —
  // we still take the number but don't follow cross-repo (we'd need the other
  // install token).
  const keywordRe = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+(?:[a-z0-9_.-]+\/[a-z0-9_.-]+)?#(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = keywordRe.exec(body)) !== null) {
    primary.add(Number(m[1]));
  }
  // Bare `#N` (or `owner/repo#N`) anywhere in the body.
  const bareRe = /(?:^|\s|\()(?:[a-z0-9_.-]+\/[a-z0-9_.-]+)?#(\d+)\b/gi;
  while ((m = bareRe.exec(body)) !== null) {
    const n = Number(m[1]);
    if (!primary.has(n)) secondary.add(n);
  }
  return {
    primary: Array.from(primary).slice(0, 3),
    secondary: Array.from(secondary).slice(0, 2),
  };
}

// Pull Linear issue identifiers (e.g. "ENG-123") from PR text and branch names.
// Linear's GitHub integration injects "Fixes ENG-123" into PR bodies and names
// branches `user/eng-123-slug`, so we scan both. The body match is case-
// sensitive uppercase (the canonical form) to avoid false hits like "utf-8";
// the branch match keys off the `/<key>-<n>` segment Linear produces.
export function extractLinkedLinearIssues(body: string, branch?: string): string[] {
  const seen = new Set<string>();
  const bodyRe = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = bodyRe.exec(body || "")) !== null) {
    seen.add(`${m[1]}-${m[2]}`);
  }
  if (branch) {
    const branchRe = /\/([A-Za-z][A-Za-z0-9]{1,9})-(\d+)/g;
    while ((m = branchRe.exec(branch)) !== null) {
      seen.add(`${m[1].toUpperCase()}-${m[2]}`);
    }
  }
  return Array.from(seen).slice(0, 3);
}

// The Linear integration for the repo owner (repo -> installation -> user ->
// integration). Returns null when the owner hasn't connected Linear.
function linearIntegrationForUser(userId: string | undefined): Integration | null {
  if (!userId) return null;
  // Linear integration + acceptance-criteria sync is a Pro/Max feature. A
  // free/lapsed owner's review skips all Linear ingestion even if a stale
  // integration row lingers from a previous paid period.
  if (planForUser(userId) === "free") return null;
  return db.find("integrations", (i) => i.userId === userId && i.type === "linear");
}

// Conservative LLM match of a PR to one of a set of candidate Linear issues.
// Returns the matching issue id, or null when nothing clearly corresponds —
// guarding against both an empty candidate list and a hallucinated id. Keep the
// "Linear issue matching" marker in the prompt; the offline mock keys off it.
async function matchPrToLinearIssue(args: {
  prTitle: string;
  prBody: string;
  candidates: LinearIssueCandidate[];
}): Promise<string | null> {
  const { prTitle, prBody, candidates } = args;
  if (!candidates.length) return null;
  const system =
    "You are DevAsign's Linear issue matching step. Given a pull request and candidate Linear issues, decide which " +
    "single issue the PR is implementing. Be conservative: match only when the PR clearly corresponds to a candidate's " +
    "described work. Emit ONLY JSON: {\"id\": string | null}. Set id to the matching candidate's id, or null if none " +
    "clearly matches. Never guess.";
  const list = candidates
    .map((c, i) => `${i + 1}. id=${c.id} [${c.identifier}] ${c.title}\n${(c.description || "").slice(0, 500)}`)
    .join("\n\n");
  const userText =
    `# Pull request\n${prTitle}\n\n${(prBody || "").slice(0, 2000)}\n\n# Candidate Linear issues\n${list}`;
  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
  });
  const parsed = tryParseJSON<{ id: string | null }>(raw, { id: null });
  const id = parsed?.id || null;
  // Guard against a hallucinated id — must be one of the candidates we offered.
  return id && candidates.some((c) => c.id === id) ? id : null;
}

// Pull every URL out of a chunk of text and keep only the ones whose host the
// LLM video helper knows how to deal with (Loom / YouTube / Vimeo). This lets
// us watch a video the PR author dropped in the description without making
// them re-attach it on the Message-agent screen.
function extractVideoUrls(text: string): string[] {
  if (!text) return [];
  const urls = text.match(/https?:\/\/[^\s)>\]"']+/g) || [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (detectVideoProvider(u)) seen.add(u);
  }
  return Array.from(seen);
}

// Wrapper around the issue fetch so the caller doesn't have to repeat the
// try/catch boilerplate. Returns null on any error — we treat missing or
// inaccessible issues as "no extra context" rather than aborting the pipeline.
async function fetchIssueSafe(
  installationId: number,
  repo: { owner: string; name: string },
  num: number
): Promise<{ title: string; body: string | null } | null> {
  try {
    return await gh<{ title: string; body: string | null }>(
      installationId,
      `/repos/${repo.owner}/${repo.name}/issues/${num}`
    );
  } catch {
    return null;
  }
}

async function ghText(installationId: number, path: string, headers: Record<string, string>) {
  const { installationToken } = await import("../github/app.js");
  const token = await installationToken(installationId);
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { ...headers, Authorization: `token ${token}`, "User-Agent": "devasign-app" },
  });
  if (!res.ok) throw new Error(`gh text ${res.status} on ${path}`);
  return res.text();
}

// --- Criteria synthesis ---

// End goal placeholder for a PR with no authoritative spec (no linked issue,
// no attachments, no checkable claims in the description). Kept non-empty so
// the task still reads as "reviewed" in the UI rather than "not synthesized",
// while signalling that acceptance criteria were intentionally not invented.
const NEUTRAL_ENDGOAL =
  "No linked issue or spec — reviewed for correctness only. Provide an end goal on the PR to enable acceptance-criteria checks.";

async function synthesizeCriteria(
  review: PRReview,
  context: Context,
  hasAuthoritativeSpec: boolean,
  extra?: string
): Promise<{
  endGoal: string;
  criteria: Criterion[];
}> {
  return synthesizeCriteriaCore({
    title: `PR ${review.prTitle}`,
    sources: context.sources,
    hasAuthoritativeSpec,
    commits: context.commitMessages,
    extraInstructions: extra,
  });
}

// Format a PR's commit messages (subject + body) for criteria synthesis. Pure
// so it can be unit-tested. Per-commit and total caps keep the synthesis prompt
// bounded when a PR carries a long or chatty history.
export function formatPrCommitMessages(
  commits: Array<{ sha: string; message: string }>
): string {
  const PER_COMMIT_CAP = 2_000;
  const TOTAL_CAP = 12_000;
  const blocks = commits.map((c) => {
    const sha = c.sha.slice(0, 7);
    const msg = (c.message || "").trim();
    return `### ${sha}\n${msg ? msg.slice(0, PER_COMMIT_CAP) : "(no commit message)"}`;
  });
  return blocks.join("\n\n").slice(0, TOTAL_CAP);
}

// Criteria-synthesis prompts live in prompts.ts with the rest of the stage
// prompts; re-exported here because the bounty job, the Linear ingest job, and
// the tests import them from pipeline.ts.
export type { CriteriaMode } from "./prompts.js";
export { criteriaSynthesisSystemPrompt } from "./prompts.js";

// Source-agnostic core of criteria synthesis. Shared by the PR pipeline (above)
// and the Linear ticket-ingestion job (runLinearIngestJob), so an opened Linear
// issue and a PR that fixes it run through identical logic. `commits` is the
// PR's full commit messages, used as a fallback spec when the description is
// thin (the Linear job leaves it empty).
export async function synthesizeCriteriaCore(args: {
  title: string;
  sources: IngestedSource[];
  hasAuthoritativeSpec: boolean;
  commits?: string;
  extraInstructions?: string;
  mode?: CriteriaMode;
}): Promise<{ endGoal: string; criteria: Criterion[] }> {
  const { title, sources, hasAuthoritativeSpec, commits, extraInstructions, mode } = args;
  const system = withMaintainerInstructions(
    criteriaSynthesisSystemPrompt(hasAuthoritativeSpec, mode),
    extraInstructions
  );
  const userText =
    `# ${title}\n\n## Context\n` +
    sources
      .filter((s) => s.kind !== "diff")
      .map((s) => `### ${s.kind} (${s.ref})\n${s.text}`)
      .join("\n\n") +
    (commits ? `\n\n## Commit messages\n${commits}` : "");
  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
  });
  const parsed = tryParseJSON(raw, { endGoal: "", criteria: [] });
  // Number criteria positionally (1, 2, 3 …) rather than trusting the LLM's id —
  // the model tends to emit uppercase "C1", which then collides with the plain
  // numbers appendAddedCriteria assigns to later-commit criteria, splitting the
  // comment into two runs. Positional ids keep the whole list a single sequence.
  const criteria: Criterion[] = (parsed.criteria || []).map((c: any, i: number) => ({
    id: String(i + 1),
    text: String(c.text || ""),
    met: null,
    evidence: null,
  }));
  return { endGoal: String(parsed.endGoal || ""), criteria };
}

// ─── Linear ticket ingestion ──────────────────────────────────────────────
// Turn a fetched Linear issue into the same `IngestedSource[]` shape the PR
// pipeline feeds to criteria synthesis. The issue itself is the primary spec;
// sub-issues and comments are authoritative detail. Reused both when a ticket
// is opened (runLinearIngestJob) and when a PR is resolved to a Linear issue
// during review (ingestContext).
export function linearSourcesFromIssue(issue: LinearIssueContext): IngestedSource[] {
  const sources: IngestedSource[] = [];
  const head =
    (issue.parent ? `Parent: ${issue.parent.identifier} — ${issue.parent.title}\n` : "") +
    (issue.project ? `Project: ${issue.project.name}\n` : "") +
    (issue.labels.length ? `Labels: ${issue.labels.join(", ")}\n` : "");
  sources.push({
    kind: "linear_issue_primary",
    ref: issue.identifier,
    text: `${issue.title}\n\n${head}${issue.description || ""}`.trim(),
  });
  for (const child of issue.children) {
    sources.push({
      kind: "linear_subissue",
      ref: child.identifier,
      text: `${child.title}\n\n${child.description || ""}`.trim(),
    });
  }
  for (const c of issue.comments) {
    sources.push({
      kind: "linear_comment",
      ref: issue.identifier,
      text: c.user ? `${c.user}: ${c.body}` : c.body,
    });
  }
  // Linked resources (Figma, docs, the GitHub PR, etc.).
  for (const a of issue.attachments) {
    sources.push({
      kind: "linear_attachment",
      ref: a.url,
      text: [a.title, a.subtitle, a.url].filter(Boolean).join(" — "),
    });
  }
  // Recent status posts on the issue's project, as background context.
  if (issue.project) {
    const updates = db
      .filter("linearProjectUpdates", (u) => u.projectId === issue.project!.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 3);
    for (const u of updates) {
      sources.push({
        kind: "linear_project_update",
        ref: issue.project.name || issue.project.id,
        text: (u.health ? `[${u.health}] ` : "") + u.body,
      });
    }
  }
  return sources;
}

// True for files we can hand to the model: Linear-hosted uploads, or any URL
// with a PDF/image extension.
// Candidate file URLs come out of ticket text, so anyone who can comment picks
// them. Both halves of this used to be substring tests against the whole URL:
// `/\blinear\.app\b/` matched `linear.app.evil.com` (and any URL merely
// mentioning linear.app in a query string), and the extension test had no host
// restriction at all, so `http://169.254.169.254/latest/meta-data/x.png` was a
// "Linear file". Match the parsed hostname, and the extension against the PATH
// only. downloadLinearFile puts every hop through the SSRF guard regardless —
// this is the narrow gate in front of it, not the security boundary.
export function isLinearFileUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  // Drop the obviously-internal ones here rather than let them burn one of the
  // three download slots below (a ticket full of metadata URLs would otherwise
  // starve the real attachments). Only the cheap cases — a host that merely
  // resolves private is caught by the guard inside downloadLinearFile.
  if (isObviouslyNonPublicHost(u.hostname)) return false;
  if (isLinearHost(u.hostname)) return true;
  return /\.(pdf|png|jpe?g|webp|gif)$/i.test(u.pathname);
}

// Gather candidate file URLs from the issue body, comments, and attachments.
function collectLinearFileUrls(issue: LinearIssueContext): string[] {
  const urls = new Set<string>();
  const texts = [issue.description, ...issue.comments.map((c) => c.body)];
  for (const t of texts) {
    for (const u of (t || "").match(/https?:\/\/[^\s)>\]"']+/g) || []) {
      if (isLinearFileUrl(u)) urls.add(u);
    }
  }
  for (const a of issue.attachments) {
    if (a.url && isLinearFileUrl(a.url)) urls.add(a.url);
  }
  return Array.from(urls);
}

// Download and summarise files attached to a Linear ticket (PDFs/images) so the
// criteria step can reason about their contents. Bounded (first few, size-
// capped) and entirely best-effort.
async function summarizeLinearFiles(
  issue: LinearIssueContext,
  token: string,
  bearer: boolean
): Promise<IngestedSource[]> {
  const out: IngestedSource[] = [];
  for (const url of collectLinearFileUrls(issue).slice(0, 3)) {
    const file = await downloadLinearFile(token, url, { bearer });
    if (!file || file.size > 10_000_000) continue; // skip undownloadable / >10MB
    const summary = await summarizeLinearFile({ url, base64: file.base64, mediaType: file.mediaType });
    if (summary) out.push({ kind: "linear_file", ref: url, text: summary });
  }
  return out;
}

// Webhook-driven: a Linear ticket was opened/updated (or a comment was added).
// Fetch the full issue, synthesize acceptance criteria, and cache them on a
// Linear-sourced Task keyed `linear:<issueId>`. A PR that later targets this
// issue seeds its review criteria from here (see ingestContext).
export async function runLinearIngestJob(integrationId: string, issueId: string): Promise<void> {
  const integration = db.find("integrations", (i) => i.id === integrationId);
  if (!integration || integration.type !== "linear") {
    console.warn(`[linear] ingest: integration ${integrationId} not found`);
    return;
  }
  // OAuth access token (preferred) → Bearer; the dev personal-key path uses the
  // raw key with no scheme.
  const token = integration.tokens.accessToken || integration.tokens.apiKey || "";
  if (!token) {
    console.warn(`[linear] ingest: integration ${integrationId} has no token`);
    return;
  }
  const bearer = Boolean(integration.tokens.accessToken);

  let issue: LinearIssueContext | null;
  try {
    issue = await fetchLinearIssueContext(token, issueId, { bearer });
  } catch (err) {
    console.warn(`[linear] ingest: fetch ${issueId} failed:`, err);
    return;
  }
  if (!issue) {
    console.warn(`[linear] ingest: issue ${issueId} not found / inaccessible`);
    return;
  }

  // A real Linear ticket is always an authoritative spec. Include text context
  // plus summaries of any attached files (PDFs/images).
  const ingestSources = linearSourcesFromIssue(issue);
  ingestSources.push(...(await summarizeLinearFiles(issue, token, bearer)));
  const { endGoal, criteria } = await synthesizeCriteriaCore({
    title: `Linear ${issue.identifier}: ${issue.title}`,
    sources: ingestSources,
    hasAuthoritativeSpec: true,
  });

  const externalId = `linear:${issue.id}`;
  const now = Date.now();
  const existing = db.find("tasks", (t) => t.externalId === externalId);
  if (existing) {
    db.update("tasks", (t) => t.id === existing.id, {
      title: issue.title,
      endGoal: endGoal || existing.endGoal,
      criteria,
      externalKey: issue.identifier,
      url: issue.url,
      userId: integration.userId,
      updatedAt: now,
    });
  } else {
    db.insert("tasks", {
      id: uuid(),
      source: "linear",
      externalId,
      title: issue.title,
      endGoal: endGoal || null,
      attachments: [],
      createdAt: now,
      criteria,
      externalKey: issue.identifier,
      url: issue.url,
      userId: integration.userId,
      updatedAt: now,
    });
  }
  console.log(
    `[linear] ingest: ${issue.identifier} "${issue.title}" → ${criteria.length} criteria ` +
    `(integration ${integrationId})`
  );
}

// --- Goal refinement from video ---
//
// Gemini watched the attached videos and produced structured summaries; Opus
// now decides whether those summaries reveal product-aligned information that
// should update the end goal / criteria. Opus is told to leave the goal alone
// unless the video adds something concrete and aligned.

async function refineGoalFromVideos(args: {
  review: PRReview;
  endGoal: string;
  criteria: Criterion[];
  videos: VideoSummary[];
}): Promise<{ endGoal: string; criteria: Criterion[]; changed: boolean; rationale: string }> {
  const { review, endGoal, criteria, videos } = args;
  const system =
    "You are DevAsign's goal-refinement step. You are given an existing end goal and acceptance criteria " +
    "for a PR, plus structured summaries of one or more videos that a human attached to the task. " +
    "Decide whether the videos reveal product-aligned information that meaningfully changes what 'done' means. " +
    "Only update the goal/criteria when the video adds something concrete and clearly aligned with the product " +
    "being built. Never invent requirements the video did not actually show. " +
    'Emit ONLY JSON: {"changed": boolean, "endGoal": string, "criteria": [{"id": string, "text": string}], "rationale": string}. ' +
    "When `changed` is false, echo back the original endGoal and criteria. Treat `unreliable: true` summaries as weak evidence.";

  const videoBlock = videos
    .map((v, i) => {
      const moments = v.keyMoments.map((k) => `    ${k.t} — ${k.note}`).join("\n");
      const signals = v.acceptanceSignals.map((s) => `    - ${s}`).join("\n");
      return (
        `## Video ${i + 1} (${v.provider}, ${v.model}${v.unreliable ? ", unreliable" : ""})\n` +
        `URL: ${v.url}\n` +
        `Summary: ${v.summary}\n` +
        (moments ? `Key moments:\n${moments}\n` : "") +
        (signals ? `Acceptance signals:\n${signals}\n` : "")
      );
    })
    .join("\n");

  const userText =
    `# PR ${review.prTitle}\n\n` +
    `## Existing end goal\n${endGoal || "(none)"}\n\n` +
    `## Existing criteria\n${criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n") || "(none)"}\n\n` +
    `## Video summaries\n${videoBlock}`;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
  });
  const parsed = tryParseJSON(raw, {
    changed: false,
    endGoal,
    criteria: criteria.map((c) => ({ id: c.id, text: c.text })),
    rationale: "",
  });

  if (!parsed.changed) {
    return { endGoal, criteria, changed: false, rationale: String(parsed.rationale || "") };
  }

  const nextCriteria: Criterion[] = (parsed.criteria || []).map((c: any, i: number) => {
    const id = String(c.id || `${i + 1}`);
    const prev = criteria.find((x) => x.id === id);
    return {
      id,
      text: String(c.text || ""),
      met: prev?.met ?? null,
      evidence: prev?.evidence ?? null,
    };
  });

  return {
    endGoal: String(parsed.endGoal || endGoal),
    criteria: nextCriteria.length ? nextCriteria : criteria,
    changed: true,
    rationale: String(parsed.rationale || ""),
  };
}

// --- Review ---

type ReviewSuggestion = {
  criterionId: string;
  title: string;
  rationale: string;
  // Repo-relative file path / 1-based new-file line the suggestion anchors to,
  // for the "path/to/file.ts (Line N)" heading in the verdict comment.
  path?: string;
  line?: number;
  // Runtime-impact severity of the finding behind the suggestion. Parsed
  // leniently; absent on legacy rows and when the model omits it → "warn".
  severity?: "blocker" | "warn" | "nit";
  // Structured before/after patch — the current prompt's contract. Rendered as
  // a composed ```diff block in the verdict comment.
  patch?: SuggestedChange;
  // LEGACY: unified-diff-style snippet of the PROPOSED edit (+/- lines). The
  // current prompt requests the structured `patch` instead; kept so stored log
  // rows and old-model responses still parse/render.
  suggestedChange?: string;
  // LEGACY: complete updated function/block. The structured `patch` supersedes
  // it; kept for stored rows and old-model responses.
  codeExample?: string;
  // GitHub-flavored-markdown language identifier for `codeExample`.
  language?: string;
  // Self-contained prompt the user can paste into an external AI coding agent
  // (Cursor / Claude Code / Codex) to land the fix. Includes the relevant
  // diff hunk inline so the prompt is actionable without repo access.
  fixPrompt?: string;
};

// Lenient coercion of a model-emitted structured patch / evidence excerpt.
// Malformed shapes coerce to null — never a parse failure — and gutter
// artifacts are stripped from every code field (the prompt forbids them; this
// enforces it). Patch bodies are capped so a runaway `original` can't blow up
// the GitHub comment.
const PATCH_LINE_CAP = 40;
function coerceSuggestedChange(v: unknown): SuggestedChange | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const path = typeof o.path === "string" ? o.path.trim() : "";
  const startLine = Number(o.startLine);
  const original = typeof o.original === "string" ? o.original : "";
  const suggested = typeof o.suggested === "string" ? o.suggested : "";
  if (!path || !suggested || !Number.isInteger(startLine) || startLine <= 0) return null;
  const cap = (s: string) => s.split("\n").slice(0, PATCH_LINE_CAP).join("\n");
  return {
    path,
    startLine,
    original: cap(stripGutterArtifacts(original)),
    suggested: cap(stripGutterArtifacts(suggested)),
  };
}

function coerceEvidenceCode(v: unknown): EvidenceCode | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const path = typeof o.path === "string" ? o.path.trim() : "";
  const startLine = Number(o.startLine);
  const code = typeof o.code === "string" ? o.code : "";
  if (!path || !code.trim() || !Number.isInteger(startLine) || startLine <= 0) return null;
  return {
    path,
    startLine,
    language: typeof o.language === "string" && o.language.trim() ? o.language.trim().toLowerCase() : null,
    code: stripGutterArtifacts(code).split("\n").slice(0, PATCH_LINE_CAP).join("\n"),
  };
}

async function reviewDiff(
  review: PRReview,
  context: Context,
  criteria: Criterion[],
  prior: Map<string, PriorVerdict> = new Map(),
  extra?: string
): Promise<ReviewVerdict> {
  const system = withMaintainerInstructions(reviewSystemPrompt(), extra);
  // Keep the head of the diff, cut at a hunk boundary (never mid-hunk), and
  // mark when we drop the tail so the model reads a missing hunk as "not shown"
  // rather than "not done" (which, combined with the prior-verdict anchoring in
  // the system prompt, is what stops truncation from regressing a previously-met
  // criterion). Sized to fit the free tier's Haiku 200K-token context
  // (~75-100K tokens of diff) with room for criteria/guidance/output. Gutters
  // ("N | ", new-file numbering) are applied AFTER the cap so the model cites
  // pre-computed line numbers instead of counting.
  const DIFF_CAP = 300_000;
  const { text: cappedDiff, truncated: diffTruncated } = truncateDiffAtHunkBoundary(
    context.diff,
    DIFF_CAP
  );
  const diffBody =
    formatRawDiff(cappedDiff) +
    (diffTruncated
      ? "\n[diff truncated — later hunks omitted; absence of a change here is NOT evidence it is missing]"
      : "");
  const userText =
    `# Criteria\n${buildCriteriaSection(criteria, prior)}\n\n` +
    (context.commits ? `# Commits in this PR\n${context.commits}\n\n` : "") +
    `# Diff\n\`\`\`diff\n${diffBody}\n\`\`\`\n\n` +
    // Maintainer guidance gets its own untruncated section up top so it can't be
    // squeezed out by the 6-source supporting-context cap below; it's already
    // filtered out of that slice to avoid showing it twice.
    (context.guidance ? `# Review guidelines (binding — maintainer-attached)\n${context.guidance}\n\n` : "") +
    `# Supporting context\n` +
    context.sources
      .filter((s) => s.kind !== "diff" && s.kind !== "repo_guidance")
      .slice(0, 6)
      .map((s) => `## ${s.kind}\n${s.text.slice(0, 2000)}`)
      .join("\n\n");
  // A silently-truncated verdict is worse than a failed review: the old path
  // parsed to `criteria: []`, the merge defaulted every criterion to met:null,
  // and the PR got a confidently-wrong all-unmet comment. So: generous output
  // budget, retry once bigger, and if the verdict is still truncated or doesn't
  // cover the criteria we asked about, throw — runReviewJob's catch marks the
  // review errored and posts the failure banner instead.
  const expectedIds = criteria.map((c) => c.id);
  const ATTEMPT_MAX_TOKENS = [16_384, 32_768];
  let verdict: ReviewVerdict | null = null;
  for (const [i, maxTokens] of ATTEMPT_MAX_TOKENS.entries()) {
    const { text, stopReason } = await completeWithMeta({
      system,
      cacheSystem: true,
      maxTokens,
      messages: [{ role: "user", content: userText }],
    });
    verdict = stopReason === "max_tokens" ? null : parseReviewVerdict(text, expectedIds);
    if (verdict) break;
    if (i < ATTEMPT_MAX_TOKENS.length - 1) {
      log(review.id, "review", "Review verdict truncated or unparseable — retrying with a larger output budget", {
        detail: `stop_reason=${stopReason}; attempt ${i + 1} used max_tokens=${maxTokens}`,
      });
    }
  }
  if (!verdict) {
    if (criteria.length > 0) {
      throw new Error(
        "PR review verdict was truncated or unparseable after retry; refusing to post an all-unmet verdict"
      );
    }
    // Spec-less PR (no criteria to fail): keep the old lenient empty fallback.
    verdict = { summary: "", criteria: [], comments: [], suggestions: [] };
  }
  return verdict;
}

export type ReviewVerdict = {
  summary: string;
  criteria: Array<{
    id: string;
    met: boolean;
    evidence: string;
    evidenceCode?: EvidenceCode | null;
    suggestedChange?: SuggestedChange | null;
  }>;
  comments: Array<{ path: string; line: number; body: string }>;
  suggestions: ReviewSuggestion[];
};

// Parse the review model's JSON verdict. Returns null — rather than a lenient
// empty fallback — when the text has no parseable JSON object, or when
// `expectedIds` is non-empty and NONE of the returned criteria ids match it
// (same trim+lowercase normalization the merge step uses): an empty or
// disjoint criteria list would otherwise default every criterion to unmet.
//
// Everything BEYOND that guard parses leniently: a malformed evidenceCode /
// structured suggestedChange / severity coerces to null/undefined, never to a
// parse failure — a model that omits the new fields must never null a verdict.
// JSON extraction (parse.ts extractJSON) tolerates fences, surrounding prose,
// and truncation (repairing the complete prefix of a cut-off object).
export function parseReviewVerdict(raw: string, expectedIds: string[]): ReviewVerdict | null {
  const parsed = extractJSON(raw) as any;
  if (!parsed || typeof parsed !== "object") return null;
  const criteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  if (expectedIds.length > 0) {
    const norm = (id: unknown) => String(id ?? "").trim().toLowerCase();
    const expected = new Set(expectedIds.map(norm));
    const anyMatch = criteria.some((c: any) => expected.has(norm(c?.id)));
    if (!anyMatch) return null;
  }
  const severities = new Set(["blocker", "warn", "nit"]);
  const verdict: ReviewVerdict = {
    summary: parsed.summary || "",
    criteria: criteria.map((c: any) => ({
      ...c,
      evidenceCode: coerceEvidenceCode(c?.evidenceCode),
      suggestedChange: coerceSuggestedChange(c?.suggestedChange),
    })),
    comments: Array.isArray(parsed.comments) ? parsed.comments : [],
    suggestions: (Array.isArray(parsed.suggestions) ? parsed.suggestions : []).map((s: any) => ({
      criterionId: String(s.criterionId || ""),
      title: String(s.title || ""),
      rationale: String(s.rationale || ""),
      path: s.path ? String(s.path) : undefined,
      line:
        s.line != null && Number.isInteger(Number(s.line)) && Number(s.line) > 0
          ? Number(s.line)
          : undefined,
      severity: severities.has(s.severity) ? s.severity : "warn",
      // The prompt's structured {path,startLine,original,suggested} object goes
      // to `patch`; a legacy plain-string suggestedChange keeps its old field.
      patch: coerceSuggestedChange(s.suggestedChange) ?? undefined,
      suggestedChange:
        typeof s.suggestedChange === "string" && s.suggestedChange ? s.suggestedChange : undefined,
      codeExample: s.codeExample ? String(s.codeExample) : undefined,
      language: s.language ? String(s.language) : undefined,
      fixPrompt: s.fixPrompt ? String(s.fixPrompt) : undefined,
    })),
  };
  // Output-integrity guard: when a suggestion's own code content bleeds into a
  // prose field mid-generation, truncate the prose at the bleed boundary rather
  // than posting code soup to GitHub. Purely repairing — never drops a field.
  for (const s of verdict.suggestions) {
    const codeFields = [
      s.patch?.original,
      s.patch?.suggested,
      s.suggestedChange,
      s.codeExample,
    ].filter((c): c is string => typeof c === "string" && c.length > 0);
    const fix = repairBledProseField(s.rationale, codeFields);
    if (fix.repaired && fix.text) s.rationale = fix.text;
  }
  const summaryFix = repairBledProseField(verdict.summary, []);
  if (summaryFix.repaired && typeof summaryFix.text === "string") {
    verdict.summary = summaryFix.text;
  }
  return verdict;
}

// Markdown block inviting the maintainer to provide an end goal on a spec-less
// PR. When they reply (text, a Loom/video link, or a screenshot + description),
// the maintainer-feedback path ingests it, synthesizes acceptance criteria, and
// re-runs the review automatically.
function buildEndGoalRequestCTA(): string {
  return [
    "## Want a deeper, goal-based review?",
    'This PR isn\'t linked to an issue, so DevAsign reviewed it for correctness only. To have it checked against a concrete **end goal**, reply on this PR with what "done" looks like — DevAsign will turn it into acceptance criteria and re-review automatically.',
    "",
    "You can provide it as:",
    "- **Text** — a short description of the intended behaviour and acceptance conditions",
    "- **A Loom / YouTube / Vimeo link** — DevAsign will watch it and extract acceptance signals",
    "- **A screenshot + description** — show the expected result and describe it in the comment",
    "",
    "_Just comment on this PR — no special command needed._",
  ].join("\n");
}

// The reason a criterion failed (or a regressed one broke), for the verdict
// comment and the consolidated fix prompt. `evidence` is the review step's
// explanation; the prompt now requires it to be non-empty, but older records
// (and the rare blank result) would otherwise render a bare "not met" item with
// no "why". Fall back to a neutral sentence so the reader always gets a reason.
function reasonOrFallback(evidence: string | null | undefined): string {
  const text = (evidence || "").trim();
  return text || "The current diff doesn't yet show this requirement being satisfied.";
}

// Build the markdown body of the single verdict comment. The shape is
// intentionally scannable: end goal, then a criteria list with per-criterion
// evidence, then concrete suggestions the developer can apply in a follow-up
// commit. For a spec-less PR (no acceptance criteria) it leads with a neutral
// status instead of a synthesised end goal so we never present invented
// requirements. `lineNotes` are the LLM's line-anchored annotations — with no
// formal-review body to carry them as native inline comments, they render here
// as a "Line notes" section so everything lives in this one comment. Emoji-free
// throughout (product decision).
export function formatReviewBody(
  endGoal: string,
  filledCriteria: Criterion[],
  suggestions: ReviewSuggestion[],
  holistic: HolisticVerdict = EMPTY_HOLISTIC,
  context?: { prTitle: string; repoFullName: string; endGoalCTA?: boolean },
  prior: Map<string, PriorVerdict> = new Map(),
  lineNotes: Array<{ path: string; line: number; body: string }> = []
): string {
  const lines: string[] = [];
  const specless = filledCriteria.length === 0;
  // Defects count here too — otherwise the spec-less "no blocking bugs surfaced"
  // copy below would print directly above a list of bugs.
  const holisticItemCount =
    holistic.regressions.length +
    holistic.criticalErrors.length +
    holistic.securityFindings.length +
    holistic.defects.length;
  if (specless) {
    // The outcome header is supplied by verdictCommentBody, which embeds this
    // body beneath it — so we lead with just the explanatory paragraph to avoid
    // two near-identical headers stacked on top of each other.
    if (holisticItemCount === 0) {
      lines.push(
        "No blocking bugs, regressions, or security concerns surfaced in this diff. This PR has no linked issue or spec, so it was reviewed for correctness only — no acceptance criteria were checked.",
        ""
      );
    } else {
      lines.push(
        "This PR has no linked issue or spec, so no acceptance criteria were checked. The concerns below come from a whole-repo correctness pass.",
        ""
      );
    }
  } else if (endGoal) {
    lines.push("### End goal", endGoal, "");
  }

  // Lead with what needs attention. `splitForComment` (using the previous run's
  // verdicts) separates criteria a later commit broke (regressed) from still-open
  // ones (unmet) and the satisfied ones (met). Regressions and unmet are surfaced
  // prominently; met criteria are NOT re-listed inline on every run — they
  // collapse into a count header + a <details> block — so a re-review that only
  // added new criteria doesn't read as "all of them failed" when most already passed.
  const { regressed, unmet, met } = splitForComment(filledCriteria, prior);
  if (regressed.length) {
    lines.push("### Previously met — now broken");
    lines.push(
      "These acceptance criteria were satisfied by an earlier commit in this PR, but a later change broke them:",
      ""
    );
    for (const c of regressed) {
      lines.push(`- **${c.id} — Regressed**`);
      lines.push(`  - Required: ${c.text}`);
      lines.push(`  - What broke: ${reasonOrFallback(c.evidence)}`);
    }
    lines.push("");
  }
  // Suggestions rendered inline under an unmet criterion below are "consumed" —
  // they must not repeat in the residual "Suggested changes" section. Regressed
  // criteria keep their brief format above, so their suggestions stay residual.
  const consumed = new Set<ReviewSuggestion>();
  if (unmet.length) {
    lines.push("### Acceptance criteria not met");
    lines.push(
      "These requirements aren't satisfied by the current diff yet — each shows what was required, why it isn't met, and a suggested fix.",
      ""
    );
    unmet.forEach((c, i) => {
      const matched = suggestionsForCriterion(c.id, suggestions);
      for (const s of matched) consumed.add(s);
      // met:null means the model returned no verdict for this criterion (as
      // opposed to positively judging it unmet) — say that honestly instead of
      // asserting a failure we have no evidence for. It still blocks approval.
      const status = c.met === null ? "Could not be evaluated" : "Not met";
      const why =
        c.met === null
          ? (c.evidence || "").trim() ||
            "The reviewer could not evaluate this requirement against the diff (no verdict was returned for it)."
          : reasonOrFallback(c.evidence);
      // Heading anchors on the first suggestion's file location + title when we
      // have them; the criterion id + status always follow on the status line.
      const anchor = matched[0];
      if (anchor && anchor.path) {
        const where = `**${anchor.path}**${anchor.line ? ` (Line ${anchor.line})` : ""}`;
        lines.push(`#### ${i + 1}. ${where}${anchor.title ? ` — ${anchor.title}` : ""}`);
      } else if (anchor && anchor.title) {
        lines.push(`#### ${i + 1}. ${anchor.title}`);
      } else {
        lines.push(`#### ${i + 1}. ${c.id} — ${status}`);
      }
      lines.push("");
      lines.push(`**${c.id} — ${status}.** Required: ${c.text}`);
      lines.push("");
      if (matched.length === 0) {
        lines.push(`**Reasoning:** ${why}`);
        lines.push("");
      }
      // Structured evidence/fix from the criterion verdict itself (the current
      // prompt's contract). The criterion-level patch renders once, up front;
      // an identical patch echoed on a matched suggestion is skipped below.
      if (c.evidenceCode) appendEvidenceBlock(lines, c.evidenceCode);
      if (c.suggestedChange) appendPatchBlock(lines, c.suggestedChange);
      matched.forEach((s, j) => {
        // First suggestion's rationale joins the criterion's evidence in one
        // Reasoning paragraph; later ones stand on their own rationale.
        const reasoning = [j === 0 ? why : "", s.rationale || ""]
          .filter(Boolean)
          .join(" ");
        if (reasoning) {
          lines.push(`**Reasoning:** ${reasoning}`);
          lines.push("");
        }
        const samePatch =
          s.patch &&
          c.suggestedChange &&
          s.patch.path === c.suggestedChange.path &&
          s.patch.suggested === c.suggestedChange.suggested;
        if (s.patch && !samePatch) {
          appendPatchBlock(lines, s.patch);
        } else if (s.suggestedChange) {
          lines.push("**Suggested Change:**");
          lines.push("");
          // Hard-code the diff language tag — the LLM's `language` field
          // describes `codeExample`, not this snippet.
          appendCodeBlock(lines, s.suggestedChange, "diff");
          lines.push("");
        }
        if (s.codeExample) {
          lines.push("**Full Code:**");
          lines.push("");
          appendCodeBlock(lines, s.codeExample, s.language);
          lines.push("");
        }
      });
    });
    lines.push("");
  }
  if (met.length) {
    const header =
      unmet.length === 0 && regressed.length === 0
        ? `### All ${met.length} acceptance criteria met`
        : `### ${met.length} of ${filledCriteria.length} acceptance criteria met`;
    // Collapsed by default: the developer already saw these pass, so they're here
    // for reference, not re-litigation. The blank line after </summary> is what
    // lets GitHub render the list inside the <details>.
    lines.push(header, "", "<details><summary>Show met criteria</summary>", "");
    for (const c of met) {
      lines.push(`- **${c.id}** — ${c.text}`);
    }
    lines.push("", "</details>", "");
  }

  // New commits since the last review — the intent-vs-implementation assessment.
  // Shown whenever a re-review ingested new commits (even when criteria are
  // unchanged and nothing was flagged), so the developer always gets fresh
  // feedback on what the latest push actually did. The summary carries the
  // narrative; any findings are advisory (gating rides the appended criteria).
  if (holistic.commitIntentSummary || holistic.commitIntentFindings.length) {
    lines.push("### New commits since last review");
    if (holistic.commitIntentSummary) lines.push(holistic.commitIntentSummary, "");
    if (holistic.commitIntentFindings.length) {
      appendHolisticGroup(lines, "Intent check", holistic.commitIntentFindings);
      lines.push("");
    }
  }

  // Correctness/robustness bugs in the changed code, independent of the criteria.
  // Placed directly under the criteria verdict because this is the section that
  // can fail an otherwise-passing PR: a diff can satisfy every requirement and
  // still be wrong. Each finding states the concrete failure it produces, and
  // blocker-severity ones gate the merge.
  if (holistic.defects.length) {
    const blocking = holistic.defects.filter((f) => f.severity === "blocker").length;
    lines.push("### Bugs and correctness issues");
    lines.push(
      "Found by reviewing the changed code for correctness, independent of the acceptance criteria" +
        (blocking
          ? `. ${blocking} of these block${blocking === 1 ? "s" : ""} the merge:`
          : ". None of these block the merge:"),
      ""
    );
    appendDefectGroup(lines, holistic.defects);
    lines.push("");
  }

  // Self-admitted deferred / incomplete work the diff's own comments concede.
  // Advisory (never blocks the merge) but surfaced prominently right under the
  // criteria — this is the "the agent quietly punted part of the design" signal
  // the author needs to see before merging. Rendered for both spec'd and
  // spec-less PRs; each item carries its own copyable fix prompt.
  if (holistic.deferrals.length) {
    lines.push("### Deferred / incomplete work");
    lines.push(
      "The diff's own comments concede that parts were deferred, stubbed, or only partially implemented. " +
        "These don't block the merge — confirm each was intentional, or use the prompt to finish it:",
      ""
    );
    appendHolisticGroup(lines, "Deferred", holistic.deferrals);
    lines.push("");
  }

  // Only suggestions NOT already rendered under an unmet criterion above land
  // here (spec-less PRs, suggestions for met/regressed criteria, mismatched
  // ids). No inline per-suggestion prompts — the consolidated dropdown at the
  // bottom carries the copyable AI-agent prompt.
  const residual = suggestions.filter((s) => !consumed.has(s));
  if (residual.length) {
    lines.push("### Suggested changes");
    for (const s of residual) {
      const heading = s.criterionId
        ? `#### For ${s.criterionId} — ${s.title}`
        : `#### ${s.title}`;
      // Severity chip on the heading line (blocker/warn/nit from the review
      // sweep); absent on legacy rows.
      lines.push(s.severity ? `${heading} (${s.severity})` : heading);
      if (s.rationale) lines.push(s.rationale);
      if (s.patch) {
        lines.push("");
        appendPatchBlock(lines, s.patch);
      } else if (s.suggestedChange) {
        lines.push("");
        appendCodeBlock(lines, s.suggestedChange, "diff");
      }
      if (s.codeExample) {
        lines.push("");
        appendCodeBlock(lines, s.codeExample, s.language);
      }
      lines.push("");
    }
  }

  // Line-anchored annotations from the review step. With no formal-review body to
  // carry them as native inline comments, they live here so the whole verdict
  // stays in this single comment.
  if (lineNotes.length) {
    lines.push("### Line notes");
    for (const n of lineNotes) {
      lines.push(`- \`${n.path}:${n.line}\` — ${n.body}`);
    }
    lines.push("");
  }

  const holisticItems =
    holistic.regressions.length + holistic.criticalErrors.length + holistic.securityFindings.length;
  if (holisticItems) {
    lines.push("### Repo-wide concerns");
    if (holistic.summary) lines.push(holistic.summary, "");
    appendHolisticGroup(lines, "Regressions", holistic.regressions);
    appendHolisticGroup(lines, "Critical errors", holistic.criticalErrors);
    // Security detail deliberately does NOT render in the PR comment — it
    // lives on the Security page. The comment carries only the count + a
    // pointer; a critical finding still gates the verdict (REQUEST_CHANGES),
    // so the merge can't proceed silently.
    if (holistic.securityFindings.length) {
      const critical = holistic.securityFindings.filter(
        (f) => (f.securitySeverity ?? "medium") === "critical"
      ).length;
      const counts =
        `${holistic.securityFindings.length} security finding${holistic.securityFindings.length === 1 ? "" : "s"}` +
        (critical ? ` (${critical} critical — blocks this PR)` : "");
      lines.push(
        `**Security:** this PR introduces ${counts}. Details and remediation are on the ` +
          `[Security page](${config.webOrigin}/security${context ? `?repo=${encodeURIComponent(context.repoFullName)}` : ""}).`
      );
    }
    lines.push("");
  }

  // Pre-existing security findings in files this PR touches: pointer only —
  // the Security page owns the detail. Advisory; never blocks the merge.
  if (holistic.preexistingVulns.length) {
    lines.push(
      `**Security:** ${holistic.preexistingVulns.length} pre-existing security finding${holistic.preexistingVulns.length === 1 ? "" : "s"} ` +
        `touch${holistic.preexistingVulns.length === 1 ? "es" : ""} files in this PR (not introduced by it) — ` +
        `[view on the Security page](${config.webOrigin}/security${context ? `?repo=${encodeURIComponent(context.repoFullName)}` : ""}).`,
      ""
    );
  }

  // Pre-existing findings this PR resolved (re-verified against the PR head):
  // one positive line; the findings flip to "fix ready" on the Security page.
  if (holistic.resolvedPreexisting.length) {
    lines.push(
      `**Security:** this PR fixes ${holistic.resolvedPreexisting.length} previously-flagged security finding${holistic.resolvedPreexisting.length === 1 ? "" : "s"} — ` +
        `confirmed against this commit; ${holistic.resolvedPreexisting.length === 1 ? "it resolves" : "they resolve"} on the ` +
        `[Security page](${config.webOrigin}/security${context ? `?repo=${encodeURIComponent(context.repoFullName)}` : ""}) when merged.`,
      ""
    );
  }

  // DEVASIGN.md nits (advisory). Convention violations the diff newly introduced
  // and DEVASIGN.md statements the diff made outdated. Never block the merge —
  // surfaced as nitpicks, each with its own copyable fix prompt.
  const devasignItems = holistic.conventionFindings.length + holistic.docDriftFindings.length;
  if (devasignItems) {
    lines.push("### DEVASIGN.md");
    lines.push(
      "Checked against your repo's DEVASIGN.md conventions. These are nits — they don't block the merge:",
      ""
    );
    appendHolisticGroup(lines, "Convention nits", holistic.conventionFindings);
    appendHolisticGroup(lines, "Docs to update", holistic.docDriftFindings);
    lines.push("");
  }

  // Cross-repo impact (advisory). Sits last of the finding sections because it is
  // the only one not about code in this diff — it is about other repositories.
  const crossRepoItems = holistic.crossRepoImpacts.length + holistic.parityNotes.length;
  if (crossRepoItems) {
    lines.push("### Cross-repo impact");
    lines.push(
      "Checked other repositories in your organization for code that consumes what this " +
        "PR changes. Advisory — none of this blocks the merge:",
      ""
    );
    appendHolisticGroup(lines, "Breaks a sibling repo", holistic.crossRepoImpacts);
    appendHolisticGroup(lines, "Feature parity", holistic.parityNotes);
    lines.push("");
  }

  // Consolidated "fix everything in one paste" prompt for an external AI
  // coding agent (Claude Code, Cursor, Aider, Codex). Only included when
  // there's anything to fix — at least one unmet criterion or one review
  // finding (any category or severity). The per-suggestion fixPrompts above
  // stay too, for users who want to fix one item at a time.
  //
  // The outer fence adapts to the content (codeFence) so per-suggestion
  // fixPrompts — which themselves contain ```diff fences — can't accidentally
  // close it. GitHub renders 4+-backtick fences as code blocks with a copy
  // button, so the user gets one-click copy of the whole prompt. A blank line
  // separates the </summary> from the fence so GitHub renders the markdown
  // inside <details> instead of treating it as raw HTML.
  const findings = collectConsolidatedFindings(holistic);
  if (context && (unmet.length > 0 || findings.length > 0)) {
    const prompt = buildConsolidatedFixPrompt({
      prTitle: context.prTitle,
      repoFullName: context.repoFullName,
      endGoal,
      unmetCriteria: unmet,
      suggestions,
      findings,
    });
    const fence = codeFence(prompt);
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("<details>");
    lines.push("<summary>One prompt to fix all of this — paste into your AI coding agent</summary>");
    lines.push("");
    lines.push(fence);
    lines.push(prompt);
    lines.push(fence);
    lines.push("");
    lines.push("</details>");
  }

  // Spec-less PRs: invite an end goal (posted once; gated in runReviewJob).
  if (context?.endGoalCTA) {
    lines.push("");
    lines.push(buildEndGoalRequestCTA());
  }

  return lines.join("\n").trim() || "DevAsign review.";
}

// Flatten every category of the holistic verdict into one labelled list for
// the consolidated fix prompt. Array order doubles as display priority (most
// severe categories first, advisory nits last). Partitioning by category key
// — not by severity — means warn/nit findings (security warnings, DEVASIGN.md
// convention nits, deferred work, etc.) are included, not just blockers, and
// nothing is double-listed.
const CONSOLIDATED_FINDING_GROUPS: Array<{
  key:
    | "regressions"
    | "criticalErrors"
    | "defects"
    | "securityFindings"
    | "preexistingVulns"
    | "commitIntentFindings"
    | "consistencyFindings"
    | "deferrals"
    | "conventionFindings"
    | "docDriftFindings"
    | "crossRepoImpacts";
  label: string;
}> = [
  { key: "regressions", label: "Regression" },
  { key: "criticalErrors", label: "Critical error" },
  { key: "defects", label: "Bug" },
  // Introduced security findings keep their fixPrompt in the consolidated
  // copy-paste prompt (they gate approval; the developer needs the fix in one
  // paste). PRE-EXISTING findings are deliberately absent — their detail lives
  // on the Security page, not in the PR conversation.
  { key: "securityFindings", label: "Security" },
  { key: "commitIntentFindings", label: "New-commit review" },
  { key: "consistencyFindings", label: "Consistency" },
  { key: "deferrals", label: "Deferred work" },
  { key: "conventionFindings", label: "Convention" },
  { key: "docDriftFindings", label: "Docs" },
  // parityNotes is deliberately absent, like preexistingVulns above: this prompt
  // is pasted into an agent pointed at THIS checkout, and a parity fix belongs in
  // a different repository entirely.
  //
  // Impacts DO stay, because there is usually a fix on this side (keep the old
  // signature, make the parameter optional, ship a deprecation) — but the broken
  // caller is in the named sibling, so the label has to say so or an agent
  // pointed here will go hunting for files that do not exist in this checkout.
  { key: "crossRepoImpacts", label: "Cross-repo — the consumer is in the named repo" },
];

function collectConsolidatedFindings(
  holistic: HolisticVerdict
): Array<{ label: string; finding: HolisticFinding }> {
  const out: Array<{ label: string; finding: HolisticFinding }> = [];
  for (const { key, label } of CONSOLIDATED_FINDING_GROUPS) {
    for (const finding of holistic[key]) out.push({ label, finding });
  }
  return out;
}

// Compose a single self-contained prompt the developer can paste once into
// an external AI coding agent to fix the whole PR. Reuses the per-suggestion
// `fixPrompt`s the LLM already produces (each carries File / Symbol / Issue
// / Suggested approach / Relevant diff) so we incur no extra LLM cost; this
// is pure string composition.
// Match suggestions to a criterion by NORMALIZED id (trim + lowercase),
// mirroring the verdict→criterion merge in runReviewJob. The review LLM can
// echo `criterionId` in a different case/whitespace than the criterion's id
// ("C1" vs "c1"); a strict === would drop the patch and fall back to the
// generic fallbacks. Normalize at the comparison only — not on the stored
// suggestion — so rendered headings keep the LLM's original casing.
function suggestionsForCriterion(
  id: unknown,
  suggestions: ReviewSuggestion[]
): ReviewSuggestion[] {
  const cid = String(id ?? "").trim().toLowerCase();
  return suggestions.filter(
    (s) => String(s.criterionId ?? "").trim().toLowerCase() === cid
  );
}

function buildConsolidatedFixPrompt(args: {
  prTitle: string;
  repoFullName: string;
  endGoal: string;
  unmetCriteria: Criterion[];
  suggestions: ReviewSuggestion[];
  findings: Array<{ label: string; finding: HolisticFinding }>;
}): string {
  const { prTitle, repoFullName, endGoal, unmetCriteria, suggestions, findings } = args;
  const lines: string[] = [];
  lines.push(`You are helping fix PR "${prTitle}" in ${repoFullName}. Automated review surfaced the items below — failed acceptance criteria and review findings. Each item states what was required, what's wrong with the current diff, and how to fix it; the embedded fix blocks include the expected behavior and the relevant diff hunk. Apply each fix so the item is resolved. Items tagged **Blocker** gate approval; the rest are advisory but worth addressing. Don't introduce changes beyond what's listed.`);
  lines.push("");
  if (endGoal) {
    lines.push("## End goal");
    lines.push(endGoal);
    lines.push("");
  }
  if (unmetCriteria.length) {
    lines.push("## Failed acceptance criteria");
    lines.push("");
    unmetCriteria.forEach((c, i) => {
      lines.push(`### ${i + 1}. Required: ${c.text} (${c.id})`);
      lines.push(
        `What's wrong now: ${
          c.met === null
            ? (c.evidence || "").trim() ||
              "The reviewer could not evaluate this requirement against the diff (no verdict was returned for it) — verify it holds and make it pass."
            : reasonOrFallback(c.evidence)
        }`
      );
      lines.push("");
      lines.push("How to fix:");
      const relevant = suggestionsForCriterion(c.id, suggestions);
      if (relevant.length === 0 && !c.suggestedChange) {
        lines.push("No specific patch was suggested for this criterion. Implement the change so the Required behavior above holds, using \"What's wrong now\" as the starting point, then verify the criterion passes.");
        lines.push("");
      } else {
        // The criterion verdict's own structured patch (when present) leads —
        // it is the reviewer's concrete statement of the change that would
        // flip this criterion to met.
        if (c.suggestedChange) {
          appendPatchBlock(lines, c.suggestedChange);
        }
        for (const s of relevant) {
          if (s.fixPrompt) {
            // The per-suggestion fixPrompt is already a complete block
            // (File / Symbol / Issue / Suggested approach / Relevant diff).
            // Drop it in verbatim — nothing to reformat.
            lines.push(s.fixPrompt);
          } else {
            // Older suggestions without a fixPrompt: synthesise something
            // usable from the fields we do have.
            lines.push(`**${s.title}**`);
            if (s.rationale) lines.push(s.rationale);
            if (s.patch) {
              lines.push("");
              appendPatchBlock(lines, s.patch);
            } else if (s.suggestedChange) {
              lines.push("");
              appendCodeBlock(lines, s.suggestedChange, "diff");
            }
            if (s.codeExample) {
              lines.push("");
              appendCodeBlock(lines, s.codeExample, s.language);
            }
          }
          lines.push("");
        }
      }
    });
  }
  if (findings.length) {
    lines.push("## Review findings");
    lines.push("");
    findings.forEach(({ label, finding }, i) => {
      const sev =
        finding.severity === "blocker" ? "Blocker" : finding.severity === "warn" ? "Warn" : "Nit";
      const where = finding.path ? `\`${finding.path}\` — ` : "";
      lines.push(`### ${i + 1}. [${label} · ${sev}] ${where}${finding.concern}`);
      lines.push("");
      if (finding.fixPrompt) {
        // Each fixPrompt is already a complete block (File / Symbol / Issue /
        // Suggested approach / Relevant diff) — drop it in verbatim.
        lines.push(finding.fixPrompt);
        lines.push("");
      }
    });
  }
  lines.push("## Your task");
  lines.push("Work through every item above — the failed acceptance criteria and each review finding. For each one: understand the gap from \"What's wrong now\", implement the change so the Required behavior holds (each fix block's `Expected behavior` describes the target state), and use the `Relevant diff` hunks as the anchor for where to edit. After each change, re-verify it resolves the item. Treat **Blocker**-tagged items as required (they block approval); address the rest too.");
  return lines.join("\n").trimEnd();
}

// Defect findings render like holistic ones but carry two extra fields the
// generic renderer has no slot for: the bug class (as a leading tag) and the
// failure scenario (the thing that makes a finding actionable rather than an
// assertion). Kept separate rather than branching inside appendHolisticGroup so
// every other caller's output is byte-identical to before.
// The "path/to/file.ts:42 — " location label for a finding: gutter-derived
// line number appended when the stage supplied one.
function findingWhere(f: HolisticFinding): string {
  return f.path ? `\`${f.path}${f.line ? `:${f.line}` : ""}\` — ` : "";
}

// Structured before/after patch on a finding, indented to sit under its bullet.
function appendFindingPatch(lines: string[], f: HolisticFinding) {
  if (!f.suggestedChange) return;
  lines.push("");
  appendPatchBlock(lines, f.suggestedChange, "  ");
}

function appendDefectGroup(lines: string[], findings: HolisticFinding[]) {
  if (!findings.length) return;
  for (const f of findings) {
    const sev =
      f.severity === "blocker" ? "**Blocker**" : f.severity === "nit" ? "Nit" : "Warn";
    const cls = f.defectClass ? `\`${f.defectClass}\` — ` : "";
    lines.push(`- ${sev} — ${findingWhere(f)}${cls}${f.concern}`);
    if (f.failureScenario) {
      lines.push(`  - **How it fails:** ${f.failureScenario}`);
    }
    appendFindingPatch(lines, f);
    appendFixPrompt(lines, f.fixPrompt, /* indented */ true);
  }
}

function appendHolisticGroup(
  lines: string[],
  label: string,
  findings: HolisticFinding[]
) {
  if (!findings.length) return;
  lines.push(`#### ${label}`);
  for (const f of findings) {
    const sev = f.severity === "blocker" ? "**Blocker**" : f.severity === "nit" ? "Nit" : "Warn";
    lines.push(`- ${sev} — ${findingWhere(f)}${f.concern}`);
    appendFindingPatch(lines, f);
    appendFixPrompt(lines, f.fixPrompt, /* indented */ true);
  }
  lines.push("");
}

// Pick a code-fence backtick run strictly longer than the longest run of
// backticks already inside `content`. The fixPrompt template mandates an
// inner ```diff fence (see reviewDiff's system prompt), so a naive 3-backtick
// wrapper would be closed early by that inner fence — leaking the rest of the
// comment out as broken markdown. GitHub renders any fence of 3+ backticks;
// 4+ also keeps the one-click copy button. Minimum 3 so empty content still
// fences cleanly.
function codeFence(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) || []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

// Validate an LLM-supplied code-fence language token. GitHub/Linguist apply
// syntax coloring only when the opening fence carries a language (typescript,
// ts, py, bash, json, diff…); a bare fence renders as uncolored monospace.
// Reject anything with whitespace/backticks/junk so a malformed value can't
// corrupt the fence info string; "" means "no language" (bare fence, unchanged
// behavior).
function fenceLang(language?: string): string {
  const t = (language || "").trim().toLowerCase();
  return /^[a-z0-9+#.-]{1,20}$/.test(t) ? t : "";
}

// Push a fenced code block (opening fence tagged with the sanitized language so
// GitHub colors it, bare closing fence) onto a markdown line buffer. The fence
// length adapts to the content (codeFence) so inner backtick runs can't close
// it early; `pad` indents the whole block to sit under a list item. Mirrors the
// appendFixPrompt helper.
function appendCodeBlock(lines: string[], code: string, language?: string, pad = "") {
  const fence = codeFence(code);
  lines.push(`${pad}${fence}${fenceLang(language)}`);
  for (const ln of code.split("\n")) lines.push(`${pad}${ln}`);
  lines.push(`${pad}${fence}`);
}

// Compose a structured before/after patch into a plain unified-diff-style
// snippet (removed lines "-", added lines "+", no hunk headers) for rendering
// inside a ```diff fence.
function patchToDiff(p: SuggestedChange): string {
  const orig = p.original ? p.original.split("\n").map((l) => `-${l}`) : [];
  const sugg = p.suggested.split("\n").map((l) => `+${l}`);
  return [...orig, ...sugg].join("\n");
}

// Renders a structured suggestedChange as a labeled before/after diff block
// anchored to its file location.
function appendPatchBlock(lines: string[], patch: SuggestedChange, pad = "") {
  lines.push(`${pad}**Suggested change** (\`${patch.path}:${patch.startLine}\`):`);
  lines.push("");
  appendCodeBlock(lines, patchToDiff(patch), "diff", pad);
  lines.push("");
}

// Renders a criterion's decisive evidence excerpt with its file anchor.
function appendEvidenceBlock(lines: string[], ec: EvidenceCode, pad = "") {
  lines.push(`${pad}**Evidence** (\`${ec.path}:${ec.startLine}\`):`);
  lines.push("");
  appendCodeBlock(lines, ec.code, ec.language ?? undefined, pad);
  lines.push("");
}

// Renders the per-finding "prompt for your AI agent" block. The prompt sits in
// a fenced code block so GitHub's built-in copy button picks it up — no
// client-side wiring needed for the GitHub surface. The fence length adapts
// to the content (codeFence) so the fixPrompt's own ```diff hunk can't close
// the wrapper. The optional indent variant keeps list-rendered findings
// (holistic) readable; the 2-space pad aligns the block with the list item's
// content column so GitHub still parses it as belonging to the bullet.
function appendFixPrompt(lines: string[], fixPrompt: string | undefined, indented = false) {
  if (!fixPrompt) return;
  const pad = indented ? "  " : "";
  const fence = codeFence(fixPrompt);
  lines.push("");
  lines.push(`${pad}**Prompt for your AI agent:**`);
  lines.push("");
  lines.push(`${pad}${fence}`);
  for (const ln of fixPrompt.split("\n")) lines.push(`${pad}${ln}`);
  lines.push(`${pad}${fence}`);
}

// GitHub rejects an entire review batch if any inline comment references a
// file that isn't actually in the diff. Cheap pre-filter against the file
// paths we see in the unified diff so the verdict still lands even when the
// LLM hallucinated a path.
function diffFilePaths(diff: string): Set<string> {
  const paths = new Set<string>();
  const re = /^\+\+\+ b\/(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    paths.add(m[1].trim());
  }
  return paths;
}

// --- Output ---

async function postGithubOutput(
  review: PRReview,
  repo: { owner: string; name: string },
  install: { installationId: number } | null,
  status: PRReviewStatus,
  args: {
    endGoal: string;
    criteria: Criterion[];
    summary: string;
    suggestions: ReviewSuggestion[];
    comments: Array<{ path: string; line: number; body: string }>;
    diff: string;
    holistic: HolisticVerdict;
    // Verdict routing (resolveReviewEvent). The conversation footprint is the
    // single verdict comment, so the "review event" maps to invisible timeline
    // actions only: APPROVE → bodyless approval; REQUEST_CHANGES → dismiss our
    // stale approval (GitHub requires a body — i.e. a visible comment block — on
    // a REQUEST_CHANGES review, so we never submit one); COMMENT → nothing.
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    // When false, only the Check Run is (re)posted — used on repeat reviews of
    // a still-spec-less PR where we've already asked for an end goal.
    postConversationReview: boolean;
    // Append the "provide an end goal" call-to-action to the review body.
    endGoalCTA: boolean;
    // Id of this run's "review in progress" placeholder comment, if one was
    // posted (runReviewJob). We edit it into the verdict; null → post a fresh
    // verdict comment instead.
    progressCommentId: number | null;
    // Per-criterion verdict from the PREVIOUS run, so the comment body can tell a
    // criterion that's still-open from one an earlier commit met but a later
    // commit broke (a regression). Empty on a first review.
    prior: Map<string, PriorVerdict>;
  }
): Promise<{ verdictPosted: boolean }> {
  if (!install) return { verdictPosted: false }; // dev: nothing to post to
  const installationId = install.installationId; // captured so the closure below keeps the non-null narrowing
  const conclusion = status === "passed" ? "success" : "action_required";
  const specless = args.criteria.length === 0;

  // The LLM's line-anchored annotations. With no formal-review body to carry
  // them as native inline comments, they render inside the verdict comment as a
  // "Line notes" section. Keep the diff-path filter so a hallucinated `path`
  // doesn't put junk in the comment.
  const validPaths = diffFilePaths(args.diff);
  const lineNotes = (args.comments || []).filter(
    (c) => c.path && c.body && Number.isFinite(c.line) && validPaths.has(c.path)
  );

  // The single editable conversation comment IS the review the developer reads:
  // the full body (end goal, criteria, suggestions, line notes, feedback) under
  // an outcome headline. We edit this run's "review in progress" placeholder
  // into it (or post a fresh comment if we never captured a placeholder id).
  const fullBody = formatReviewBody(
    args.endGoal,
    args.criteria,
    args.suggestions,
    args.holistic,
    { prTitle: review.prTitle, repoFullName: `${repo.owner}/${repo.name}`, endGoalCTA: args.endGoalCTA },
    args.prior,
    lineNotes
  );
  const commentBody = verdictCommentBody({ status, specless, reviewBody: fullBody });
  // Write the verdict into the conversation comment; returns whether it landed.
  // `editOnly` skips posting a fresh comment when there's no placeholder to edit
  // — used on the refresh-only path, where a brand-new standalone comment each
  // run would just be noise. Best-effort: a commenting hiccup must never abort
  // the review.
  const writeVerdictComment = async (editOnly = false): Promise<boolean> => {
    if (args.progressCommentId !== null) {
      return updatePRComment(installationId, repo.owner, repo.name, args.progressCommentId, commentBody);
    }
    if (editOnly) return false;
    const id = await postPRCommentReturningId(installationId, repo.owner, repo.name, review.prNumber, commentBody);
    if (id !== null) {
      // Persist so a same-sha rerun reuses this comment even though the
      // placeholder POST at run start failed.
      setStatus(review.id, { progressCommentId: id, progressCommentSha: review.headSha });
    }
    return id !== null;
  };

  // Check Run is keyed to head_sha, so it's always (re)posted — it updates the
  // commit status without adding conversation noise.
  try {
    await gh(install.installationId, `/repos/${repo.owner}/${repo.name}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: "DevAsign · End goal",
        head_sha: review.headSha,
        status: "completed",
        conclusion,
        output: {
          title:
            status === "passed"
              ? specless
                ? "No issues found — add an end goal for acceptance-criteria review"
                : "All acceptance criteria met"
              : "Changes requested",
          summary: args.summary || "",
        },
      }),
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.warn("[review] failed to post check run:", err);
  }

  // Already asked for an end goal on a prior pass: refresh only the Check Run and
  // update the verdict comment in place (no fresh conversation comment). Edit-only
  // so a still-spec-less re-review doesn't post a brand-new comment each run.
  if (!args.postConversationReview) {
    return { verdictPosted: await writeVerdictComment(true) };
  }

  // Review-event routing — timeline-only signals, never a comment block:
  // - APPROVE: bodyless approval (GitHub renders just "approved these changes").
  //   Store its id so a later failing commit can withdraw it.
  // - REQUEST_CHANGES: never submitted (its required body would render as an
  //   extra conversation comment). Instead, dismiss our earlier approval so the
  //   merge gate (branch protection + the action_required Check Run) stays
  //   honest after a regression.
  // - COMMENT (spec-less pass / advisory downgrade): nothing to submit.
  // Best-effort: a failure here must not block the verdict comment below.
  if (args.event === "APPROVE") {
    try {
      const res = await gh<{ id?: number }>(
        install.installationId,
        `/repos/${repo.owner}/${repo.name}/pulls/${review.prNumber}/reviews`,
        {
          method: "POST",
          body: JSON.stringify({ event: "APPROVE" }),
          headers: { "Content-Type": "application/json" },
        }
      );
      if (typeof res?.id === "number") {
        setStatus(review.id, { approveReviewId: res.id });
      }
    } catch (err) {
      console.warn("[review] failed to post approval:", err);
    }
  } else if (args.event === "REQUEST_CHANGES" && review.approveReviewId != null) {
    const dismissed = await dismissPRReview(
      install.installationId,
      repo.owner,
      repo.name,
      review.prNumber,
      review.approveReviewId,
      "A newer commit did not pass the DevAsign review; the earlier approval no longer applies."
    );
    if (dismissed) {
      setStatus(review.id, { approveReviewId: null });
      log(review.id, "verdict", "Withdrew earlier approval", {
        detail: "A newer commit did not pass review; the stale approval was dismissed.",
      });
    }
  }

  // Edit the placeholder into the full verdict (or post it fresh if we never
  // captured a placeholder id).
  return { verdictPosted: await writeVerdictComment() };
}

// Lightweight "changes requested" signal that blocks the merge WITHOUT re-running
// the review pipeline and WITHOUT adding any conversation comment. Refreshes the
// Check Run to action_required and — in blocking mode (event=REQUEST_CHANGES) —
// dismisses our earlier bodyless approval so a stale green review can't keep the
// merge unlocked. We never submit a REQUEST_CHANGES review here: GitHub requires
// a body on it, which would render as an extra comment block; the maintainer-
// feedback path has already posted the implementation guide as the one allowed
// comment. Advisory mode (event=COMMENT, resolved by the caller via
// resolveReviewEvent) skips the dismissal so the merge stays unblocked.
// Best-effort: each call is independently guarded.
async function postChangesRequestedNotice(
  review: PRReview,
  repo: { owner: string; name: string },
  install: { installationId: number },
  args: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; summary: string }
): Promise<void> {
  try {
    await gh(install.installationId, `/repos/${repo.owner}/${repo.name}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: "DevAsign · End goal",
        head_sha: review.headSha,
        status: "completed",
        conclusion: "action_required",
        output: { title: "Changes requested", summary: args.summary || "" },
      }),
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.warn("[feedback] failed to refresh check run:", err);
  }
  if (args.event === "REQUEST_CHANGES" && review.approveReviewId != null) {
    const dismissed = await dismissPRReview(
      install.installationId,
      repo.owner,
      repo.name,
      review.prNumber,
      review.approveReviewId,
      "Maintainer feedback added new acceptance criteria; the earlier approval no longer applies."
    );
    if (dismissed) {
      setStatus(review.id, { approveReviewId: null });
      log(review.id, "verdict", "Withdrew earlier approval", {
        detail: "New acceptance criteria from maintainer feedback; the stale approval was dismissed.",
      });
    }
  }
}

// --- Mid-review bug-fix comments ---
//
// When the user uploads a Loom mid-review to flag a new bug fix that should
// land in the same PR, we post a discrete issue comment to the PR rather than
// a fresh review. This keeps the verdict state untouched (it'll refresh
// naturally on the next `synchronize` webhook) and gives the developer
// something concrete to react to immediately.

type BugFixSynthesis = {
  title: string;
  broken: string;
  expected: string;
  fix: string;
  code?: string;
  // GitHub-flavored-markdown language identifier for `code`, so the fenced
  // block renders colored on GitHub.
  language?: string;
};

async function synthesizeBugFix(args: {
  videoSummary: VideoSummary;
  prTitle: string;
  diffSlice: string;
}): Promise<BugFixSynthesis> {
  const { videoSummary, prTitle, diffSlice } = args;
  const system =
    "You are DevAsign's bug-fix synthesis step. The user attached a video showing a bug they want fixed in an " +
    "open PR. Emit ONLY JSON: {\"title\": string, \"broken\": string, \"expected\": string, \"fix\": string, \"code\"?: string, \"language\"?: string}. " +
    "`title` is ≤ 80 chars and reads like a PR/commit subject. `broken` describes the observed (incorrect) behavior " +
    "from the video. `expected` describes the correct behavior the video implies. `fix` is 1–2 sentences of " +
    "remediation. `code` is an optional minimal code example anchored in the PR diff — never invent a full file. " +
    "When you include `code`, set `language` to its GitHub-flavored-markdown language identifier (lowercase, e.g. typescript, python, go, bash); omit `language` if the snippet has no clear language. " +
    "Never invent behavior the video did not actually show; if you are uncertain say so in `fix`.";
  const moments = videoSummary.keyMoments.map((k) => `  ${k.t} — ${k.note}`).join("\n");
  const signals = videoSummary.acceptanceSignals.map((s) => `  - ${s}`).join("\n");
  const userText =
    `# PR\n${prTitle}\n\n` +
    `# Video summary (${videoSummary.provider}, ${videoSummary.model}` +
    `${videoSummary.unreliable ? ", unreliable" : ""})\n` +
    `URL: ${videoSummary.url}\n` +
    `Summary: ${videoSummary.summary}\n` +
    (moments ? `Key moments:\n${moments}\n` : "") +
    (signals ? `Acceptance signals:\n${signals}\n` : "") +
    `\n# Current diff (truncated)\n\`\`\`diff\n${diffSlice.slice(0, 20_000)}\n\`\`\``;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
  });
  const parsed = tryParseJSON<Partial<BugFixSynthesis>>(raw, {});
  return {
    title: String(parsed.title || "New bug fix requested").slice(0, 80),
    broken: String(parsed.broken || ""),
    expected: String(parsed.expected || ""),
    fix: String(parsed.fix || ""),
    code: parsed.code ? String(parsed.code) : undefined,
    language: parsed.language ? String(parsed.language) : undefined,
  };
}

function formatBugFixComment(bug: BugFixSynthesis, videoUrl: string): string {
  const lines: string[] = [
    `### Bug observed in attached video — ${bug.title}`,
    "",
  ];
  if (bug.broken) lines.push("**What's broken**", bug.broken, "");
  if (bug.expected) lines.push("**Expected**", bug.expected, "");
  if (bug.fix) lines.push("**Suggested fix**", bug.fix, "");
  if (bug.code) {
    appendCodeBlock(lines, bug.code, bug.language);
    lines.push("");
  }
  lines.push(`_Source: ${videoUrl}_`);
  return lines.join("\n");
}

// Post a discrete bug-fix comment on the PR conversation for a freshly-added
// video attachment. Idempotent in the sense that we don't track posted state
// — re-uploading the same Loom posts another comment. Fire-and-forget from
// the routes layer; never throws to the caller.
export async function postBugFixCommentForAttachment(
  taskId: string,
  attachment: { kind: string; url?: string; note?: string }
): Promise<void> {
  const url = attachment.url;
  if (!url) return;
  // Only act on video-like attachments — text/PDF/image uploads should not
  // trigger this path.
  if (attachment.kind !== "loom" && !(attachment.kind === "link" && detectVideoProvider(url))) {
    return;
  }
  const task = db.find("tasks", (t) => t.id === taskId);
  if (!task) return;
  // Only PR-bound tasks have an associated PR review to comment on.
  const m = task.externalId.match(/^pr:([^:]+):(\d+)$/);
  if (!m) return;
  const repoId = m[1];
  const prNumber = Number(m[2]);
  const repo = db.find("repositories", (r) => r.id === repoId);
  if (!repo) return;
  const install = db.find("installations", (i) => i.id === repo.installationId);
  if (!install) return; // dev: no install, nothing to post to

  // Find the latest review row for this PR so we can log against it.
  const review = db
    .filter("prReviews", (r) => r.repoId === repoId && r.prNumber === prNumber)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  let diff = "";
  try {
    diff = await ghText(
      install.installationId,
      `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`,
      { Accept: "application/vnd.github.v3.diff" }
    );
  } catch (err) {
    console.warn("[bugfix] failed to fetch diff:", err);
  }

  let videoSummary: VideoSummary;
  try {
    videoSummary = await summarizeVideo({ url, note: attachment.note });
  } catch (err) {
    console.warn("[bugfix] gemini summarize failed:", err);
    return;
  }

  let bug: BugFixSynthesis;
  try {
    bug = await synthesizeBugFix({
      videoSummary,
      prTitle: task.title,
      diffSlice: diff,
    });
  } catch (err) {
    console.warn("[bugfix] opus synthesis failed:", err);
    return;
  }

  const body = formatBugFixComment(bug, url);
  try {
    await gh(
      install.installationId,
      `/repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.warn("[bugfix] failed to post issue comment:", err);
    return;
  }

  if (review) {
    log(review.id, "comment", "Posted bug-fix comment from mid-review video", {
      target: url,
      detail: bug.title,
      meta: { provider: videoSummary.provider, unreliable: videoSummary.unreliable },
    });
  }
}

// --- Maintainer feedback ingestion ---
//
// When the repo owner / org member / collaborator drops a comment on the PR
// — or submits a formal review with body text — we treat it as a new
// feedback signal: refine the end goal/criteria if the comment adds something
// concrete, then post an "implementation guide" comment back so the developer
// has a targeted next step. We don't re-run the full diff verdict here; the
// next `synchronize` webhook will refresh it once the developer pushes.

type ImplementationGuide = {
  title: string;
  ask: string;
  approach: string;
  code?: string;
  // GitHub-flavored-markdown language identifier for `code`, so the fenced
  // block renders colored on GitHub.
  language?: string;
  references: string[];
};

function extractDocUrls(text: string): string[] {
  if (!text) return [];
  const urls = text.match(/https?:\/\/[^\s)>\]"']+/g) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (detectVideoProvider(u)) continue; // videos go through Gemini path
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

async function refineGoalFromFeedback(args: {
  review: PRReview;
  endGoal: string;
  criteria: Criterion[];
  feedback: {
    author: string;
    authorAssociation: string;
    body: string;
    videoSummaries: VideoSummary[];
    docUrls: string[];
    sourceUrl: string;
  };
}): Promise<{
  endGoal: string;
  criteria: Criterion[];
  added: Criterion[];
  changed: boolean;
  rationale: string;
  disputed: Array<{ id: string; claim: string }>;
  reopened: Array<{ id: string; claim: string }>;
}> {
  const { review, endGoal, criteria, feedback } = args;
  const system =
    "You are DevAsign's maintainer-feedback goal refinement step. A maintainer or collaborator left a comment " +
    "on an open PR. Decide whether the comment (plus any video summaries or doc references it carries) adds " +
    "any NEW acceptance criteria — concrete, independently checkable requirements that aren't already covered " +
    "by the existing list. Never invent requirements the feedback didn't actually state. " +
    "Existing acceptance criteria are LOCKED: you must not remove, rephrase, renumber, merge, or restate them " +
    "(disputing a verdict, below, is allowed and never changes a criterion's text). " +
    "Your additive job is to return only brand-new criteria the comment introduces. If the comment is " +
    "conversational, off-topic, asks a question, or only restates something already in the list, return " +
    "`addedCriteria: []` and `changed: false`. " +
    "If there are NO existing acceptance criteria (the criteria list below is empty — the PR had no linked spec) and " +
    "the comment supplies goal or acceptance information, treat the comment as the authoritative specification and " +
    "populate `addedCriteria` directly from it (its text plus any video summaries or referenced docs provided). " +
    "You may refine `endGoal` to reflect the new direction, but only when `addedCriteria` is non-empty — otherwise " +
    "echo the original endGoal back unchanged. " +
    "SEPARATELY from additions, the comment may DISPUTE an existing verdict: claim that a criterion currently marked " +
    "[currently UNMET] is in fact already satisfied (a false-positive finding), often by pointing to code that lives " +
    "outside the PR diff. For each disputed criterion, add {id, claim} to `disputedCriteria`, where `claim` is a " +
    "one-sentence paraphrase of why the maintainer says it is satisfied. Only dispute criteria shown as " +
    "[currently UNMET]; never dispute a [currently MET] one, and never invent a dispute the comment did not make. " +
    "Disputing only requests re-verification against the codebase — it does NOT itself mark anything met. A single " +
    "comment may both add new criteria and dispute existing ones. " +
    "CONVERSELY, the comment may RE-OPEN a verdict: claim that a criterion currently marked [currently MET] is in " +
    "fact NOT satisfied (the previous review passed it wrongly, or the maintainer's bar is higher than what shipped). " +
    "For each such criterion, add {id, claim} to `reopenedCriteria`, where `claim` is a one-sentence paraphrase of " +
    "why the maintainer says it is not satisfied. Only re-open criteria shown as [currently MET]; never re-open a " +
    "[currently UNMET] one (it is already open), and never invent a re-open the comment did not make. A re-opened " +
    "criterion is the maintainer reasserting the bar, so it WILL be marked unmet and block the merge. " +
    'Emit ONLY JSON: {"changed": boolean, "endGoal": string, "addedCriteria": [{"text": string}], "disputedCriteria": [{"id": string, "claim": string}], "reopenedCriteria": [{"id": string, "claim": string}], "rationale": string}. ' +
    "Each `addedCriteria.text` is one independently checkable statement. Do NOT include ids on additions — the system " +
    "assigns them. Each `disputedCriteria[].id` and `reopenedCriteria[].id` MUST be an existing criterion id from the " +
    "list below; a single criterion must never appear in both.";

  const videoBlock = feedback.videoSummaries
    .map((v, i) => {
      const moments = v.keyMoments.map((k) => `    ${k.t} — ${k.note}`).join("\n");
      const signals = v.acceptanceSignals.map((s) => `    - ${s}`).join("\n");
      return (
        `## Video ${i + 1} (${v.provider}, ${v.model}${v.unreliable ? ", unreliable" : ""})\n` +
        `URL: ${v.url}\nSummary: ${v.summary}\n` +
        (moments ? `Key moments:\n${moments}\n` : "") +
        (signals ? `Acceptance signals:\n${signals}\n` : "")
      );
    })
    .join("\n");
  const docBlock = feedback.docUrls.length
    ? feedback.docUrls.map((u) => `- ${u}`).join("\n")
    : "(none)";

  const userText =
    `# PR ${review.prTitle}\n\n` +
    `## Existing end goal\n${endGoal || "(none)"}\n\n` +
    `## Existing criteria\n${criteria.map((c) => `- ${c.id}: [${c.met === true ? "currently MET" : c.met === false ? "currently UNMET" : "not yet evaluated"}] ${c.text}`).join("\n") || "(none)"}\n\n` +
    `## Maintainer feedback\n` +
    `Author: ${feedback.author} (${feedback.authorAssociation})\n` +
    `Source: ${feedback.sourceUrl}\n\n${feedback.body}\n\n` +
    `## Referenced docs\n${docBlock}\n\n` +
    (videoBlock ? `## Referenced video summaries\n${videoBlock}` : "");

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
  });
  const parsed = tryParseJSON<{
    changed?: boolean;
    endGoal?: string;
    addedCriteria?: Array<{ text?: string }>;
    disputedCriteria?: Array<{ id?: string; claim?: string }>;
    reopenedCriteria?: Array<{ id?: string; claim?: string }>;
    rationale?: string;
  }>(raw, { changed: false, endGoal, addedCriteria: [], disputedCriteria: [], reopenedCriteria: [], rationale: "" });

  const addedTexts = (parsed.addedCriteria || [])
    .map((c) => String(c?.text || "").trim())
    .filter(Boolean);
  const rationale = String(parsed.rationale || "");

  // Disputes (currently-unmet → maybe met) and re-opens (currently-met → unmet)
  // both reference EXISTING criteria by id; the merge never touches text. Each is
  // filtered to ids that exist AND are in the right starting state, so a
  // hallucinated id or wrong-direction claim is dropped silently. A criterion
  // can't be in both. Disputes are re-verified against the codebase before any
  // flip (high cost of a wrong clear); re-opens are honored on the maintainer's
  // authority (a re-open only blocks the merge, never unblocks it).
  const disputed = (parsed.disputedCriteria || [])
    .map((d) => ({ id: String(d?.id || "").trim(), claim: String(d?.claim || "").trim() }))
    .filter((d) => d.id && criteria.some((c) => c.id === d.id && c.met !== true));
  const reopenedIds = new Set<string>();
  const reopened = (parsed.reopenedCriteria || [])
    .map((d) => ({ id: String(d?.id || "").trim(), claim: String(d?.claim || "").trim() }))
    .filter((d) => {
      if (!d.id || reopenedIds.has(d.id)) return false;
      // Re-open only a currently-met criterion that isn't also being disputed.
      if (disputed.some((x) => x.id === d.id)) return false;
      if (!criteria.some((c) => c.id === d.id && c.met === true)) return false;
      reopenedIds.add(d.id);
      return true;
    });

  // The merge is what enforces the additive contract: existing criteria pass
  // through bit-for-bit (so met/evidence from prior reviews survive) and the
  // new ones get appended with fresh non-colliding ids. `changed` is derived
  // from whether any additions actually landed — that way the contract stays
  // self-consistent even when the model contradicts itself.
  if (!addedTexts.length) {
    return { endGoal, criteria, added: [], changed: false, rationale, disputed, reopened };
  }
  const nextCriteria = appendAddedCriteria(criteria, addedTexts);
  return {
    endGoal: String(parsed.endGoal || endGoal),
    criteria: nextCriteria,
    // The tail beyond the prior list is exactly what the comment introduced —
    // the copyable prompt lists these so the developer's agent knows the new bar.
    added: nextCriteria.slice(criteria.length),
    changed: true,
    rationale,
    disputed,
    reopened,
  };
}

// When a maintainer disputes a finding (claims a criterion marked unmet is in
// fact already satisfied), re-verify ONLY the disputed criteria against the full
// codebase — the PR diff PLUS the repo index slice — not just the changed hunk.
// This is the path that clears false positives the original review failed only
// because the satisfying code lived outside the diff. Verify-gated, never
// authority-gated: a criterion flips to met:true only when the model can cite
// concrete code that satisfies it AND returns non-empty evidence; an
// unverifiable claim keeps it unmet. Returns one result per disputed id; the
// caller's merge ignores ids it doesn't recognise.
async function rescoreDisputedCriteria(args: {
  review: PRReview;
  criteria: Criterion[];
  disputed: Array<{ id: string; claim: string }>;
  diff: string;
  holistic: HolisticContext;
  feedback: { author: string; authorAssociation: string; body: string };
  extra?: string;
}): Promise<{ results: Array<{ id: string; met: boolean; evidence: string }> }> {
  const { review, criteria, disputed, diff, holistic, feedback } = args;
  const disputedIds = new Set(disputed.map((d) => d.id));
  const targets = criteria.filter((c) => disputedIds.has(c.id));
  if (!targets.length) return { results: [] };

  const system = withMaintainerInstructions(
    "You are DevAsign's maintainer-dispute re-evaluation step. A maintainer claims that one or more acceptance " +
    "criteria the previous review marked NOT met are in fact already satisfied by the code — typically by code that " +
    "lives OUTSIDE the PR diff hunk. Re-check ONLY the criteria listed below, against the full evidence provided: the " +
    "PR diff AND the repository index (summaries of the touched files, their dependents, and a repo manifest). " +
    "Decide each independently and on the evidence — NOT on the maintainer's authority or association. Set met:true " +
    "ONLY when you can point to concrete code (name the file and the function/symbol) that satisfies the criterion, and " +
    "cite it in `evidence`. If the provided evidence does not let you confirm the claim, keep met:false and in " +
    "`evidence` state exactly what you checked and what is still missing. 'Not shown in the diff' is NEVER sufficient " +
    "to confirm OR to deny — judge against the repository code, not just the changed hunk. Never invent code that " +
    "isn't in the diff or index. " +
    'Emit ONLY JSON: {"results": [{"id": string, "met": boolean, "evidence": string}]}. ' +
    "Return exactly one result per criterion id given below, using those ids verbatim.",
    args.extra
  );

  const touchedBlock = holistic.entries.slice(0, holistic.touchedCount)
    .map((e) =>
      `### ${e.path}\nExports: ${e.exports.join(", ") || "(none)"}\nImports: ${e.imports.join(", ") || "(none)"}\nSummary: ${e.summary}`
    )
    .join("\n\n");
  const dependentsBlock = holistic.entries.slice(holistic.touchedCount)
    .map((e) => `### ${e.path}\nSummary: ${e.summary}`)
    .join("\n\n");
  const manifestBlock = holistic.manifest.map((m) => `- ${m.path}: ${m.summary}`).join("\n");

  const criteriaBlock = targets
    .map((c) => {
      const claim = disputed.find((d) => d.id === c.id)?.claim || "";
      return (
        `- ${c.id}: ${c.text}\n` +
        `  Previous verdict: NOT met — ${c.evidence || "(no evidence recorded)"}\n` +
        `  Maintainer's claim: ${claim || "(the criterion is already satisfied)"}`
      );
    })
    .join("\n");

  const userText =
    `# PR ${review.prTitle}\n\n` +
    `# Maintainer\n${feedback.author} (${feedback.authorAssociation})\n\n` +
    `# Disputed criteria to re-check\n${criteriaBlock}\n\n` +
    `# Maintainer comment\n${feedback.body}\n\n` +
    `# PR diff\n\`\`\`diff\n${diff.slice(0, 40_000)}\n\`\`\`\n\n` +
    (touchedBlock ? `# Touched files (repo index)\n${touchedBlock}\n\n` : "") +
    (dependentsBlock ? `# Dependent files (repo index)\n${dependentsBlock}\n\n` : "") +
    (manifestBlock ? `# Repo manifest\n${manifestBlock}\n` : "");

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
  });
  const parsed = tryParseJSON<{ results?: Array<{ id?: string; met?: boolean; evidence?: string }> }>(
    raw,
    { results: [] }
  );

  const valid = new Set(targets.map((c) => c.id));
  const results = (parsed.results || [])
    .map((r) => {
      const id = String(r?.id || "").trim();
      const evidence = String(r?.evidence || "").trim();
      // Verify-gate enforced in code, not just the prompt: a flip to met needs
      // cited evidence. An empty-evidence "met" is treated as unverified.
      const met = r?.met === true && evidence.length > 0;
      return {
        id,
        met,
        evidence:
          evidence ||
          "Re-checked against the codebase; no concrete evidence found that this criterion is satisfied.",
      };
    })
    .filter((r) => valid.has(r.id));
  return { results };
}

async function synthesizeImplementationGuide(args: {
  feedback: {
    author: string;
    body: string;
    videoSummaries: VideoSummary[];
    docUrls: string[];
  };
  endGoal: string;
  criteria: Criterion[];
  prTitle: string;
  diffSlice: string;
}): Promise<ImplementationGuide> {
  const { feedback, endGoal, criteria, prTitle, diffSlice } = args;
  const system =
    "You are DevAsign's implementation guide synthesis step. A maintainer left feedback on a PR; produce a " +
    "concise guide the developer can act on in a follow-up commit. Emit ONLY JSON: " +
    "{\"title\": string, \"ask\": string, \"approach\": string, \"code\"?: string, \"language\"?: string, \"references\": string[]}. " +
    "`title` ≤ 80 chars, commit-subject style. `ask` paraphrases what the maintainer wants in 1–2 sentences. " +
    "`approach` is 1–3 short paragraphs explaining how to implement it, anchored in the current diff where " +
    "possible. `code` is an optional minimal patch snippet — never a full file. When you include `code`, set " +
    "`language` to its GitHub-flavored-markdown language identifier (lowercase, e.g. typescript, python, go, bash); " +
    "omit `language` if the snippet has no clear language. `references` echoes any doc " +
    "URLs the maintainer cited. Never invent requirements the feedback didn't state. " +
    "Never use emoji in any text you output.";

  const videoBlock = feedback.videoSummaries
    .map(
      (v, i) =>
        `Video ${i + 1} (${v.provider}${v.unreliable ? ", unreliable" : ""}): ${v.summary}`
    )
    .join("\n");
  const docBlock = feedback.docUrls.length
    ? feedback.docUrls.map((u) => `- ${u}`).join("\n")
    : "(none)";

  const userText =
    `# PR\n${prTitle}\n\n` +
    `# Current end goal\n${endGoal || "(none)"}\n\n` +
    `# Current criteria\n${criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n") || "(none)"}\n\n` +
    `# Maintainer feedback (${feedback.author})\n${feedback.body}\n\n` +
    `# Referenced docs\n${docBlock}\n\n` +
    (videoBlock ? `# Referenced videos\n${videoBlock}\n\n` : "") +
    `# Current diff (truncated)\n\`\`\`diff\n${diffSlice.slice(0, 20_000)}\n\`\`\``;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
  });
  const parsed = tryParseJSON<Partial<ImplementationGuide>>(raw, {});
  return {
    title: String(parsed.title || "Maintainer feedback to address").slice(0, 80),
    ask: String(parsed.ask || ""),
    approach: String(parsed.approach || ""),
    code: parsed.code ? String(parsed.code) : undefined,
    language: parsed.language ? String(parsed.language) : undefined,
    references: Array.isArray(parsed.references) ? parsed.references.map(String) : [],
  };
}

// Compose the single paste-once prompt the developer hands to their own AI
// coding agent to implement the maintainer's feedback. Pure string composition
// from the guide the LLM already synthesised plus the criteria the comment
// introduced — no extra LLM call (mirrors buildConsolidatedFixPrompt). Rendered
// inside formatImplementationGuide's fenced "Prompt for your AI agent" block.
function buildFeedbackFixPrompt(args: {
  prTitle: string;
  repoFullName: string;
  guide: ImplementationGuide;
  newCriteria: Criterion[];
}): string {
  const { prTitle, repoFullName, guide, newCriteria } = args;
  const lines: string[] = [];
  lines.push(
    `You are implementing maintainer feedback on PR "${prTitle}" in ${repoFullName}. ` +
      `Apply the change in a new commit so the automated review can re-check it.`
  );
  lines.push("");
  if (guide.ask) {
    lines.push("## What to implement", guide.ask, "");
  }
  if (guide.approach) {
    lines.push("## Suggested approach", guide.approach, "");
  }
  if (guide.code) {
    lines.push("## Reference snippet");
    appendCodeBlock(lines, guide.code, guide.language);
    lines.push("");
  }
  if (newCriteria.length) {
    lines.push("## Acceptance criteria to satisfy");
    for (const c of newCriteria) lines.push(`- ${c.text}`);
    lines.push("");
  }
  if (guide.references.length) {
    lines.push("## References");
    for (const r of guide.references) lines.push(`- ${r}`);
    lines.push("");
  }
  lines.push("## Your task");
  lines.push(
    "Implement the above so each acceptance criterion is satisfied, then commit. " +
      "Keep the change scoped to this feedback — don't introduce unrelated edits."
  );
  return lines.join("\n").trimEnd();
}

export function formatImplementationGuide(
  guide: ImplementationGuide,
  comment: { author: string; sourceUrl: string },
  ctx: { prTitle: string; repoFullName: string; newCriteria: Criterion[]; hasReopened?: boolean }
): string {
  // Describe accurately what moved the bar: new criteria, re-opened ones, or both.
  const reason = ctx.newCriteria.length > 0 && ctx.hasReopened
    ? "added new and re-opened existing acceptance criteria"
    : ctx.hasReopened
      ? "re-opened existing acceptance criteria"
      : "added new acceptance criteria";
  const lines: string[] = [
    `### How to implement ${comment.author}'s feedback — ${guide.title}`,
    "",
    // The changes-requested notice lives here rather than in a formal review:
    // a REQUEST_CHANGES review requires a body, which GitHub renders as an
    // extra comment block — this guide is the one comment the feedback gets.
    `**Changes requested** — this feedback ${reason}, so the PR's ` +
      "status is changes-requested until they are addressed. The review re-runs " +
      "automatically when you push a new commit.",
    "",
  ];
  if (guide.ask) lines.push("**What they asked**", guide.ask, "");
  if (guide.approach) lines.push("**Suggested approach**", guide.approach, "");
  if (guide.code) {
    appendCodeBlock(lines, guide.code, guide.language);
    lines.push("");
  }
  if (guide.references.length) {
    lines.push("**References**");
    for (const r of guide.references) lines.push(`- ${r}`);
    lines.push("");
  }
  // Copy-paste prompt for the developer's own AI agent — rendered in a fenced
  // block (via appendFixPrompt) so GitHub's one-click copy button picks it up.
  const fixPrompt = buildFeedbackFixPrompt({
    prTitle: ctx.prTitle,
    repoFullName: ctx.repoFullName,
    guide,
    newCriteria: ctx.newCriteria,
  });
  appendFixPrompt(lines, fixPrompt);
  lines.push("");
  if (comment.sourceUrl) lines.push(`_Source: ${comment.sourceUrl}_`);
  return lines.join("\n");
}

// The security gate is never softened (see decisions.ts), so a maintainer
// dispute that clears the last open criteria can't approve a PR over an
// outstanding blocker. Blocker state isn't persisted on the review, so before
// flipping to passed we re-run the same security backstop the main pipeline uses
// (c.1 / c.1a) against the unchanged diff + repo index. Returns whether the diff
// introduces a blocker. Best-effort; emits one finding-log per surfaced issue.
async function detectIntroducedBlockers(args: {
  review: PRReview;
  repo: Repository;
  diff: string;
  holistic: HolisticContext;
}): Promise<{ hasBlocker: boolean; summary: string }> {
  const { review, repo, diff, holistic } = args;
  const wf = effectiveWorkflow(repo);
  const holisticRan = wf.stages.holistic && (holistic.entries.length > 0 || holistic.manifest.length > 0);
  if (holisticRan) {
    const v = await reviewAgainstRepo({ review, diff, holistic, extraInstructions: wf.prompts?.holistic });
    for (const f of v.regressions) emitFindingLog(review.id, "regression", f);
    for (const f of v.criticalErrors) emitFindingLog(review.id, "criticalError", f);
    for (const f of v.securityFindings) emitFindingLog(review.id, "security", f);
    const hasBlocker = [...v.regressions, ...v.criticalErrors, ...v.securityFindings].some(
      (f) => f.severity === "blocker"
    );
    return { hasBlocker, summary: v.summary };
  }
  if (diff) {
    const sec = await reviewDiffSecurity({
      review,
      diff,
      touched: holistic.entries.slice(0, holistic.touchedCount),
      extraInstructions: wf.prompts?.holistic,
    });
    for (const f of sec.securityFindings) emitFindingLog(review.id, "security", f);
    return { hasBlocker: sec.securityFindings.some((f) => f.severity === "blocker"), summary: sec.summary };
  }
  return { hasBlocker: false, summary: "" };
}

// The dispute counterpart to postChangesRequestedNotice: a maintainer's
// false-positive correction was VERIFIED against the codebase and cleared the
// last open criteria, so the PR now passes. Post the correction comment, flip the
// Check Run to success, and submit a bodyless APPROVE (stored so a later failing
// commit can withdraw it). Best-effort; each step is independently guarded.
async function postApprovalAfterCorrection(
  review: PRReview,
  repo: { owner: string; name: string },
  install: { installationId: number },
  args: { summary: string; commentBody: string }
): Promise<void> {
  try {
    await postPRCommentReturningId(
      install.installationId,
      repo.owner,
      repo.name,
      review.prNumber,
      args.commentBody
    );
  } catch (err) {
    console.warn("[feedback] failed to post correction comment:", err);
  }
  try {
    await gh(install.installationId, `/repos/${repo.owner}/${repo.name}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: "DevAsign · End goal",
        head_sha: review.headSha,
        status: "completed",
        conclusion: "success",
        output: { title: "All acceptance criteria met", summary: args.summary || "" },
      }),
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.warn("[feedback] failed to refresh check run:", err);
  }
  if (review.approveReviewId == null) {
    try {
      const res = await gh<{ id?: number }>(
        install.installationId,
        `/repos/${repo.owner}/${repo.name}/pulls/${review.prNumber}/reviews`,
        {
          method: "POST",
          body: JSON.stringify({ event: "APPROVE" }),
          headers: { "Content-Type": "application/json" },
        }
      );
      if (typeof res?.id === "number") setStatus(review.id, { approveReviewId: res.id });
    } catch (err) {
      console.warn("[feedback] failed to post approval:", err);
    }
  }
}

// The comment DevAsign posts after re-checking a maintainer's dispute. When the
// re-review confirmed the maintainer (the finding was a false positive) it reads
// as an acknowledgement plus the verifying evidence; when it could not, it
// explains what was checked and what still stands. No emoji, matching the other
// review-comment steps.
function formatDisputeResolutionComment(args: {
  cleared: Array<{ id: string; text: string; evidence: string }>;
  stillUnmet: Criterion[];
  approved: boolean;
  sourceUrl: string;
  blockerSummary?: string;
}): string {
  const lines: string[] = [];
  if (args.approved) {
    lines.push("**Re-reviewed after your note — you're right, these were false positives.**");
    lines.push("");
    lines.push(
      "I re-checked the disputed criteria against the full codebase (not just the PR diff) and confirmed they are satisfied:"
    );
  } else {
    lines.push("**Re-reviewed after your note.**");
    lines.push("");
    lines.push("I re-checked the disputed criteria against the full codebase (not just the PR diff).");
  }
  if (args.cleared.length) {
    lines.push("");
    for (const c of args.cleared) lines.push(`- **${c.id} — now met.** ${c.evidence}`);
  }
  if (args.stillUnmet.length) {
    lines.push("");
    lines.push("Still open after re-review:");
    for (const c of args.stillUnmet) lines.push(`- **${c.id}** — ${c.evidence || c.text}`);
  }
  // All criteria cleared but the security backstop held the merge — explain why,
  // otherwise the developer sees "criteria met" with no reason for the block.
  if (!args.approved && args.blockerSummary) {
    lines.push("");
    lines.push("**However, changes are still requested:**");
    lines.push(args.blockerSummary);
  }
  if (args.approved) {
    lines.push("");
    lines.push("All acceptance criteria are now met, so I've updated the verdict to approved.");
  }
  if (args.sourceUrl) {
    lines.push("");
    lines.push(`_Source: ${args.sourceUrl}_`);
  }
  return lines.join("\n");
}

export async function runMaintainerFeedbackJob(
  reviewId: string,
  comment: MaintainerComment
): Promise<void> {
  // Belt-and-braces bot loop guard: even with the webhook-layer filter, refuse
  // to act on a comment whose author looks like our own App bot.
  const botSuffix = `${config.github.appName}[bot]`.toLowerCase();
  if (comment.author.toLowerCase() === botSuffix) return;

  const review = db.find("prReviews", (r) => r.id === reviewId);
  if (!review) return;
  const repo = db.find("repositories", (r) => r.id === review.repoId);
  if (!repo) return;
  const install = db.find("installations", (i) => i.id === repo.installationId);

  // Tier the model by the repo owner's plan and open a usage scope, exactly like
  // runReviewJob: this job makes several LLM calls (refineGoalFromFeedback,
  // rescoreDisputedCriteria, synthesizeImplementationGuide, detectIntroducedBlockers)
  // that must respect plan restrictions and roll their token cost into one scope.
  const plan = install?.userId ? planForUser(install.userId) : null;
  const reviewModel = plan ? modelForPlan(plan) : config.llm.model;

  return withModel(reviewModel, () => withUsage(async () => {
  // The "comment arrived" log is written synchronously by the webhook
  // handler so the Agent page surfaces the comment before this job even
  // dequeues. Here we mark the start of the analysis phase — the brain
  // icon on `criteria` reads as "the agent is thinking" in the timeline.
  log(review.id, "criteria", "Analyzing maintainer comment for product-aligned changes", {
    target: comment.sourceUrl,
    detail: `${comment.author} (${comment.authorAssociation}): ${comment.body.slice(0, 240)}`,
    meta: { sourceEvent: comment.sourceEvent },
  });

  // Video URLs in the comment → Gemini, and persist them onto the task so
  // future review passes (and the existing video-refinement step) see them.
  const videoUrls = extractVideoUrls(comment.body);
  const docUrls = extractDocUrls(comment.body);

  const videoSummaries: VideoSummary[] = [];
  for (const url of videoUrls) {
    try {
      videoSummaries.push(await summarizeVideo({ url, note: `maintainer comment by ${comment.author}` }));
    } catch (err) {
      console.warn("[feedback] video summarize failed:", err);
    }
  }

  // Stash any new video URLs as `loom`-shaped task attachments so the next
  // full review pass replays them through the main ingestion path.
  const task = db.find("tasks", (t) => t.externalId === taskExternalId(review));
  if (task && videoUrls.length) {
    const known = new Set(task.attachments.map((a) => a.url || ""));
    const fresh = videoUrls.filter((u) => !known.has(u)).map((u) => ({
      id: uuid(),
      kind: "loom" as const,
      url: u,
      note: `from maintainer ${comment.author}`,
      createdAt: Date.now(),
    }));
    if (fresh.length) {
      db.update("tasks", (t) => t.id === task.id, {
        attachments: [...task.attachments, ...fresh],
      });
    }
  }

  if (videoSummaries.length) {
    log(review.id, "ingest", "Videos in maintainer feedback summarized", {
      detail: `${videoSummaries.length} video(s)`,
      meta: {
        videos: videoSummaries.map((v) => ({
          url: v.url,
          provider: v.provider,
          unreliable: v.unreliable,
        })),
      },
    });
  }

  const refined = await refineGoalFromFeedback({
    review,
    // When the PR is spec-less (no criteria yet), the stored endGoal is just
    // the neutral placeholder — pass "" so the model treats this comment as the
    // authoritative spec and bootstraps criteria from it.
    endGoal: review.criteria.length === 0 ? "" : task?.endGoal || "",
    criteria: review.criteria,
    feedback: {
      author: comment.author,
      authorAssociation: comment.authorAssociation,
      body: comment.body,
      videoSummaries,
      docUrls,
      sourceUrl: comment.sourceUrl,
    },
  });

  // Pull the latest diff once: the implementation guide anchors on it, and the
  // dispute re-check + security backstop verify against it plus the repo index.
  // Best-effort — a missing install or fetch failure just means we work from the
  // feedback + repo index alone.
  let diffSlice = "";
  if (install) {
    try {
      diffSlice = await ghText(
        install.installationId,
        `/repos/${repo.owner}/${repo.name}/pulls/${review.prNumber}`,
        { Accept: "application/vnd.github.v3.diff" }
      );
    } catch (err) {
      console.warn("[feedback] failed to fetch diff:", err);
    }
  }
  const holistic = gatherHolisticContext(repo, diffSlice);

  // 1. Re-verify any disputed verdicts against the full codebase BEFORE settling
  //    status. A dispute claims a criterion we marked unmet is actually satisfied
  //    by code outside the diff; rescoreDisputedCriteria checks the repo index and
  //    flips unmet→met only on cited evidence. Runs in dev too (LLM-only, no
  //    GitHub calls) so the correction is observable without an install.
  let criteria = refined.criteria;
  const cleared: Array<{ id: string; text: string; evidence: string }> = [];
  if (refined.disputed.length) {
    const wfForDispute = effectiveWorkflow(repo);
    const rescore = await rescoreDisputedCriteria({
      review,
      criteria,
      disputed: refined.disputed,
      diff: diffSlice,
      holistic,
      feedback: {
        author: comment.author,
        authorAssociation: comment.authorAssociation,
        body: comment.body,
      },
      extra: wfForDispute.prompts?.review,
    });
    const byId = new Map(rescore.results.map((r) => [r.id, r]));
    criteria = criteria.map((c) => {
      const r = byId.get(c.id);
      if (!r) return c;
      if (r.met && c.met !== true) cleared.push({ id: c.id, text: c.text, evidence: r.evidence });
      // A flipped verdict invalidates the review-time structured evidence/fix —
      // stale code excerpts must not survive under the new verdict.
      return { ...c, met: r.met, evidence: r.evidence, evidenceCode: null, suggestedChange: null };
    });
    log(review.id, "criteria", "Re-evaluated disputed criteria against the codebase", {
      detail: `${cleared.length} of ${refined.disputed.length} disputed criterion/criteria verified and cleared`,
      meta: { disputed: refined.disputed.map((d) => d.id), cleared: cleared.map((c) => c.id) },
    });
  }

  // 1b. Re-opens: the maintainer reasserts that a previously-MET criterion is NOT
  //     satisfied. Unlike a clear, this is NOT verify-gated — re-opening only ever
  //     blocks the merge, so the maintainer's authority on "done" prevails (this is
  //     symmetric with adding a new criterion). We flip met→unmet and record the
  //     maintainer's reason as the evidence; gating it on a re-check would just
  //     recreate the original "agent won't listen to the maintainer" bug in reverse.
  const reopened: Array<{ id: string; text: string }> = [];
  if (refined.reopened.length) {
    const claimById = new Map(refined.reopened.map((r) => [r.id, r.claim]));
    criteria = criteria.map((c) => {
      if (!claimById.has(c.id) || c.met !== true) return c;
      reopened.push({ id: c.id, text: c.text });
      return {
        ...c,
        met: false,
        evidence: `Re-opened by ${comment.author}: ${claimById.get(c.id) || "the maintainer says this is not actually satisfied."}`,
        // The met-time evidence excerpt no longer supports the verdict.
        evidenceCode: null,
        suggestedChange: null,
      };
    });
    log(review.id, "criteria", "Re-opened criteria at maintainer's request", {
      detail: `${reopened.length} previously-met criterion/criteria re-opened`,
      meta: { reopened: reopened.map((r) => r.id) },
    });
  }

  // 2. Bar-moved-up path: the comment introduced brand-new criteria and/or re-opened
  //    previously-met ones. Either way the PR can no longer read as approved, so we
  //    request changes and post the implementation guide. Any disputes were already
  //    merged into `criteria` above. New/re-opened criteria are unmet, so the status
  //    is changes_requested regardless — no need to re-run the diff verdict here;
  //    that fires on the next `synchronize` once the developer pushes.
  if (refined.changed || reopened.length) {
    if (task && refined.changed) {
      db.update("tasks", (t) => t.id === task.id, { endGoal: refined.endGoal });
    }
    setStatus(review.id, { criteria, status: "changes_requested" });
    log(
      review.id,
      "criteria",
      refined.changed ? "End goal updated from maintainer feedback" : "Criteria re-opened from maintainer feedback",
      {
        detail: refined.rationale || refined.endGoal || `Re-opened ${reopened.length} criterion/criteria.`,
        meta: {
          count: criteria.length,
          added: refined.added.length,
          reopened: reopened.length,
          cleared: cleared.length,
          statusGated: true,
        },
      }
    );

    const guide = await synthesizeImplementationGuide({
      feedback: { author: comment.author, body: comment.body, videoSummaries, docUrls },
      endGoal: refined.endGoal,
      criteria,
      prTitle: review.prTitle,
      diffSlice,
    });

    if (!install) return; // dev: nothing to post to

    const body = formatImplementationGuide(guide, comment, {
      prTitle: review.prTitle,
      repoFullName: `${repo.owner}/${repo.name}`,
      newCriteria: refined.added,
      hasReopened: reopened.length > 0,
    });
    try {
      await gh(
        install.installationId,
        `/repos/${repo.owner}/${repo.name}/issues/${review.prNumber}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (err) {
      console.warn("[feedback] failed to post implementation guide:", err);
      return;
    }
    log(review.id, "comment", "Posted implementation guide for maintainer feedback", {
      target: comment.sourceUrl,
      detail: guide.title,
      meta: { author: comment.author, refs: guide.references.length },
    });

    const wf = effectiveWorkflow(repo);
    const { event: reviewEvent } = resolveReviewEvent({
      status: "changes_requested",
      specless: criteria.length === 0,
      blocking: wf.verdict.blocking,
      endGoalAlreadyRequested: !!task?.endGoalRequestedAt,
    });
    await postChangesRequestedNotice(review, repo, install, {
      event: reviewEvent,
      summary: refined.changed
        ? "Maintainer feedback added new acceptance criteria; see the implementation guide."
        : "Maintainer re-opened acceptance criteria; see the implementation guide.",
    });
    log(review.id, "verdict", "Changes requested — merge blocked; awaiting developer commit", {
      meta: { event: reviewEvent, reReview: false },
    });
    return;
  }

  // 3. No new criteria, but the comment disputed verdicts: settle status from the
  //    re-scored criteria. The security gate is never softened — a flip to passed
  //    re-checks the diff for introduced blockers first (detectIntroducedBlockers).
  if (refined.disputed.length) {
    const allMet = criteria.length > 0 && criteria.every((c) => c.met === true);
    let status: PRReviewStatus = "changes_requested";
    let blockerSummary = "";
    if (allMet) {
      const blockers = await detectIntroducedBlockers({ review, repo, diff: diffSlice, holistic });
      blockerSummary = blockers.summary;
      status = blockers.hasBlocker ? "changes_requested" : "passed";
    }
    setStatus(review.id, { criteria, status });
    if (status === "passed") {
      log(review.id, "verdict", "Verdict corrected after maintainer dispute — all criteria met", {
        detail: `Cleared ${cleared.length} false-positive finding(s) after verifying against the codebase.`,
        meta: { cleared: cleared.map((c) => c.id), status },
      });
    } else {
      log(review.id, "criteria", "Disputed criteria re-evaluated; changes still requested", {
        detail: cleared.length
          ? `Cleared ${cleared.length} finding(s); ${criteria.filter((c) => c.met !== true).length} still unmet.`
          : "Re-checked the disputed criteria against the codebase; the findings stand.",
        meta: { cleared: cleared.map((c) => c.id), status },
      });
    }

    if (!install) return; // dev: status updated; nothing to post

    if (status === "passed") {
      await postApprovalAfterCorrection(review, repo, install, {
        summary: blockerSummary || "All acceptance criteria met after re-review.",
        commentBody: formatDisputeResolutionComment({
          cleared,
          stillUnmet: [],
          approved: true,
          sourceUrl: comment.sourceUrl,
        }),
      });
    } else {
      const stillUnmet = criteria.filter((c) => c.met !== true);
      try {
        await gh(
          install.installationId,
          `/repos/${repo.owner}/${repo.name}/issues/${review.prNumber}/comments`,
          {
            method: "POST",
            body: JSON.stringify({
              body: formatDisputeResolutionComment({
                cleared,
                stillUnmet,
                approved: false,
                sourceUrl: comment.sourceUrl,
                blockerSummary,
              }),
            }),
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (err) {
        console.warn("[feedback] failed to post dispute resolution comment:", err);
      }
      const wf = effectiveWorkflow(repo);
      const { event: reviewEvent } = resolveReviewEvent({
        status: "changes_requested",
        specless: criteria.length === 0,
        blocking: wf.verdict.blocking,
        endGoalAlreadyRequested: !!task?.endGoalRequestedAt,
      });
      await postChangesRequestedNotice(review, repo, install, {
        event: reviewEvent,
        summary: "Re-reviewed the disputed criteria; changes are still requested.",
      });
    }
    return;
  }

  // 4. Nothing actionable: the original acknowledgement that we saw the comment.
  //    The "Maintainer feedback received" + this "reviewed; unchanged" pair in the
  //    review log is the agent's observable acknowledgement.
  log(review.id, "criteria", "Maintainer feedback reviewed; end goal unchanged", {
    detail: refined.rationale || "No actionable change inferred from the comment.",
  });
  }));
}

// --- Helpers ---

function taskExternalId(review: PRReview) {
  return `pr:${review.repoId}:${review.prNumber}`;
}

function findOrCreateTask(review: PRReview): Task {
  const externalId = taskExternalId(review);
  const existing = db.find("tasks", (t) => t.externalId === externalId);
  if (existing) return existing;
  const task: Task = {
    id: uuid(),
    source: "github",
    externalId,
    title: review.prTitle,
    endGoal: null,
    attachments: [],
    createdAt: Date.now(),
  };
  db.insert("tasks", task);
  return task;
}

function tryParseJSON<T>(raw: string, fallback: T): T {
  // Multi-strategy extraction (parse.ts): fenced ```json, raw parse, an
  // escape-aware brace scan, then truncated-JSON repair — a cut-off stage
  // response recovers its complete prefix instead of dropping to the fallback.
  const parsed = extractJSON(raw);
  return parsed == null ? fallback : (parsed as T);
}

// ─── Whole-repo (holistic) review ─────────────────────────────────────────
// Uses the per-file repo index to answer: does this diff break anything, miss
// a critical edge, or introduce a security flaw? Runs in addition to the
// acceptance-criteria check; a blocker-severity finding flips status to
// changes_requested even when every criterion is otherwise met.

export type HolisticFinding = {
  path?: string;
  concern: string;
  // "nit" sits below "warn": purely advisory DEVASIGN.md findings that never
  // gate the merge and render as nitpicks. Only "blocker" gates (see the status
  // gate in runReviewJob).
  severity: "blocker" | "warn" | "nit";
  // 4-tier severity for SECURITY findings only (the Security page's model).
  // The legacy 2-tier field above is derived from it (critical → "blocker",
  // everything else → "warn") so every renderer and the verdict gate keep
  // working — and "blocker gates" now means exactly "critical gates".
  securitySeverity?: SecuritySeverity;
  // Defect pass only (reviewDiffDefects): taxonomy tag for the bug class —
  // "null-deref", "unhandled-error", "race-condition", "resource-leak",
  // "api-misuse", "data-loss", etc. Display only; nothing branches on it.
  defectClass?: string;
  // Defect pass only: concrete inputs/state -> the wrong outcome that follows.
  // REQUIRED by that pass — normaliseDefectFindings DROPS any finding without
  // one, mirroring the security agent's "no 3-step exploit narrative, no
  // finding" rule (security/agent.ts). A model that can't say what actually
  // goes wrong is speculating, and speculation must not gate a merge.
  failureScenario?: string;
  // Self-contained prompt the user can paste into an external AI coding agent
  // to land the fix. Includes the relevant diff hunk inline.
  fixPrompt?: string;
  // 1-based NEW-file line the finding anchors to, read from the diff's
  // pre-computed "N | " gutter. Absent when not tied to a single line.
  line?: number;
  // Structured before/after patch for the finding, when a single-site
  // replacement exists. Rendered as a composed ```diff block.
  suggestedChange?: SuggestedChange | null;
};

type HolisticVerdict = {
  regressions: HolisticFinding[];
  criticalErrors: HolisticFinding[];
  securityFindings: HolisticFinding[];
  // General correctness/robustness bugs the diff introduces (reviewDiffDefects).
  // Runs on EVERY review, independent of the repo index and of whether the PR
  // has acceptance criteria — the criteria pass only judges what was asked for,
  // and a diff that satisfies every requirement can still be wrong. Gating:
  // blocker-severity defects feed hasBlocker exactly like regressions and
  // criticalErrors do (and so respect the repo's advisory-verdict mode).
  defects: HolisticFinding[];
  // Legacy advisory bucket for codebase-consistency deviations. No pass
  // currently populates it (the former spec-less pass was removed); kept so the
  // verdict shape and its renderers stay stable. Always empty today.
  consistencyFindings: HolisticFinding[];
  // Self-admitted "deferred / incomplete work" the diff's own comments concede
  // — TODOs, stubs, "for now", "deferred to a follow-up", NotImplemented, etc.
  // Detected by a separate regex-gated pass (detectDeferredWork) on both the
  // spec'd and spec-less paths. Advisory — surfaced prominently but never
  // blocks a merge (forced severity "warn"), like consistencyFindings.
  deferrals: HolisticFinding[];
  // DEVASIGN.md guidance pass (reviewAgainstDevasignDocs). `conventionFindings`
  // are rules the diff newly violates; `docDriftFindings` are DEVASIGN.md
  // statements the diff makes outdated (docs need updating). Both advisory —
  // forced severity "nit", never gate a merge. Empty when the repo has no
  // applicable DEVASIGN.md.
  conventionFindings: HolisticFinding[];
  docDriftFindings: HolisticFinding[];
  // Vulnerabilities that ALREADY exist in files this PR touches or depends on,
  // read from the repo index's stored security audit (not introduced by this
  // diff). Advisory — forced severity "warn", never gate the merge. Surfaced so
  // the author sees latent risk in the code they're working near.
  preexistingVulns: HolisticFinding[];
  // Pre-existing vulnerabilities this PR RESOLVED: stored vulns in files the PR
  // modifies that re-verification against the PR head confirmed are gone. Positive
  // confirmation that the agent saw the fix — advisory, never gates, no fixPrompt.
  // Empty when nothing was re-verified or nothing was fixed.
  resolvedPreexisting: HolisticFinding[];
  // New-commit intent review (reviewNewCommits, re-reviews only): per-commit
  // notes on whether the delta diff matches each new commit's stated intent.
  // Advisory (forced "warn") — gating happens via criteria synthesized from that
  // intent. `commitIntentSummary` is the narrative shown even when no criteria
  // changed and no findings surfaced. Empty/"" on first reviews and same-sha reruns.
  commitIntentFindings: HolisticFinding[];
  commitIntentSummary: string;
  // Cross-repo stage (Pro/Max, off by default). `crossRepoImpacts` are sibling
  // repositories this change breaks; `parityNotes` are capabilities it adds that
  // siblings lack. Both advisory — severity is forced at normalisation, and
  // neither feeds hasBlocker.
  crossRepoImpacts: HolisticFinding[];
  parityNotes: HolisticFinding[];
  summary: string;
};

export const EMPTY_HOLISTIC: HolisticVerdict = {
  regressions: [],
  criticalErrors: [],
  securityFindings: [],
  defects: [],
  consistencyFindings: [],
  deferrals: [],
  conventionFindings: [],
  docDriftFindings: [],
  preexistingVulns: [],
  resolvedPreexisting: [],
  commitIntentFindings: [],
  commitIntentSummary: "",
  crossRepoImpacts: [],
  parityNotes: [],
  summary: "",
};

type HolisticContext = {
  entries: RepoIndexEntry[];      // [...touched, ...dependents]
  touchedCount: number;
  dependentCount: number;
  manifest: Array<{ path: string; summary: string }>;
};

const HOLISTIC_TOUCHED_CAP = 25;
const HOLISTIC_DEPENDENT_CAP = 25;
const HOLISTIC_MANIFEST_CAP = 20;

function gatherHolisticContext(repo: Repository, diff: string): HolisticContext {
  const state = repo.indexState ?? "none";
  if (state !== "ready" && state !== "stale") {
    return { entries: [], touchedCount: 0, dependentCount: 0, manifest: [] };
  }
  const touchedPaths = diffFilePaths(diff);
  const allEntries = db.filter("repoIndex", (e) => e.repoId === repo.id);
  if (!allEntries.length) {
    return { entries: [], touchedCount: 0, dependentCount: 0, manifest: [] };
  }
  const byPath = new Map(allEntries.map((e) => [e.path, e]));
  const touched: RepoIndexEntry[] = [];
  for (const p of touchedPaths) {
    const e = byPath.get(p);
    if (e) touched.push(e);
  }

  // Dependents heuristic: match imports against touched basenames + exported
  // symbols. Misses aliased re-exports and barrel files, but catches the
  // common case without a language-specific resolver.
  const touchedSymbols = new Set<string>();
  for (const t of touched) {
    const base = (t.path.split("/").pop() || t.path).replace(/\.[^.]+$/, "");
    touchedSymbols.add(base);
    for (const ex of t.exports) touchedSymbols.add(ex);
  }
  const touchedIds = new Set(touched.map((t) => t.id));
  const dependents: RepoIndexEntry[] = [];
  for (const e of allEntries) {
    if (touchedIds.has(e.id)) continue;
    const matches = e.imports.some((imp) => {
      const tail = (imp.split("/").pop() || imp).replace(/\.[^.]+$/, "");
      return touchedSymbols.has(tail);
    });
    if (matches) dependents.push(e);
  }

  const cappedTouched = touched.slice(0, HOLISTIC_TOUCHED_CAP);
  const cappedDependents = dependents.slice(0, HOLISTIC_DEPENDENT_CAP);

  // Manifest: a short tour of the rest of the repo so the LLM has a mental
  // model beyond the touched slice. Largest code files by size is a crude
  // but cheap importance proxy.
  const manifest = allEntries
    .filter((e) => /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift|cs|cc|cpp)$/i.test(e.path))
    .sort((a, b) => b.size - a.size)
    .slice(0, HOLISTIC_MANIFEST_CAP)
    .map((e) => ({ path: e.path, summary: e.summary }));

  return {
    entries: [...cappedTouched, ...cappedDependents],
    touchedCount: cappedTouched.length,
    dependentCount: cappedDependents.length,
    manifest,
  };
}

async function reviewAgainstRepo(args: {
  review: PRReview;
  diff: string;
  holistic: HolisticContext;
  extraInstructions?: string;
}): Promise<HolisticVerdict> {
  const { holistic } = args;
  if (!holistic.entries.length && !holistic.manifest.length) return EMPTY_HOLISTIC;

  const system = withMaintainerInstructions(holisticSystemPrompt(), args.extraInstructions);

  const touchedBlock = holistic.entries.slice(0, holistic.touchedCount)
    .map((e) =>
      `### ${e.path}\n` +
      `Exports: ${e.exports.join(", ") || "(none)"}\n` +
      `Imports: ${e.imports.join(", ") || "(none)"}\n` +
      `Flags: ${e.securityFlags.join(", ") || "(none)"}\n` +
      `Summary: ${e.summary}`
    )
    .join("\n\n");
  const dependentsBlock = holistic.entries.slice(holistic.touchedCount)
    .map((e) =>
      `### ${e.path}\n` +
      `Imports: ${e.imports.join(", ") || "(none)"}\n` +
      `Summary: ${e.summary}`
    )
    .join("\n\n");
  const manifestBlock = holistic.manifest
    .map((m) => `- ${m.path}: ${m.summary}`)
    .join("\n");

  const holDiff = truncateDiffAtHunkBoundary(args.diff, 40_000);
  const userText =
    `# Diff\n\`\`\`diff\n${formatRawDiff(holDiff.text)}${holDiff.truncated ? "\n[diff truncated — later hunks omitted]" : ""}\n\`\`\`\n\n` +
    `# Touched files (repo index summaries)\n${touchedBlock || "(none indexed)"}\n\n` +
    `# Dependent files\n${dependentsBlock || "(none)"}\n\n` +
    `# Repo manifest (top-level tour)\n${manifestBlock || "(none)"}`;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    // Structured suggestedChange objects make findings materially bigger than
    // the old concern+fixPrompt shape; 1500 would truncate multi-finding runs.
    maxTokens: 4096,
  });
  const parsed = tryParseJSON<Partial<HolisticVerdict>>(raw, EMPTY_HOLISTIC);
  return {
    ...EMPTY_HOLISTIC,
    regressions: normaliseFindings(parsed.regressions),
    criticalErrors: normaliseFindings(parsed.criticalErrors),
    securityFindings: normaliseSecurityFindings(parsed.securityFindings),
    // The model's own advisory bucket for vulns it can SEE in the provided
    // summaries but that this diff did not introduce. Forced "warn" (advisory,
    // never gates) and merged with the stored-audit stream by the caller.
    preexistingVulns: normaliseFindings(parsed.preexistingVulns).map((f) => ({
      ...f,
      severity: "warn" as const,
    })),
    summary: String(parsed.summary || ""),
  };
}

// Security-only review of the diff. The backstop that guarantees a security
// pass runs on EVERY review even when the heavy holistic stage is toggled off
// or no repo index exists — without it, "non-downgradeable security blocker"
// would be hollow, since a repo could silently disable security by turning the
// holistic stage off. When the holistic stage already ran with an index it owns
// security and this is skipped, so security is analyzed exactly once. Touched
// index summaries are passed when available but aren't required (a diff-only
// security review is valid).
async function reviewDiffSecurity(args: {
  review: PRReview;
  diff: string;
  touched: RepoIndexEntry[];
  extraInstructions?: string;
}): Promise<{ securityFindings: HolisticFinding[]; summary: string }> {
  const { touched } = args;
  const system = withMaintainerInstructions(securitySystemPrompt(), args.extraInstructions);

  const touchedBlock = touched
    .map((e) =>
      `### ${e.path}\n` +
      `Flags: ${e.securityFlags.join(", ") || "(none)"}\n` +
      `Summary: ${e.summary}`
    )
    .join("\n\n");
  const secDiff = truncateDiffAtHunkBoundary(args.diff, 40_000);
  const userText =
    `# Diff\n\`\`\`diff\n${formatRawDiff(secDiff.text)}${secDiff.truncated ? "\n[diff truncated — later hunks omitted]" : ""}\n\`\`\`\n\n` +
    `# Touched files (repo index summaries)\n${touchedBlock || "(none indexed)"}`;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 4096,
  });
  const parsed = tryParseJSON<{ securityFindings?: unknown; summary?: unknown }>(raw, {});
  return {
    securityFindings: normaliseSecurityFindings(parsed.securityFindings),
    summary: String(parsed.summary || ""),
  };
}

// ─── General defect review ─────────────────────────────────────────────────
//
// The gap this closes: every other stage judges the diff against something the
// PR promised. reviewDiff scores acceptance criteria, reviewAgainstRepo asks
// "does this break what already worked", reviewDiffSecurity hunts vulns. None
// of them asks the plain question — is this code correct? A PR can satisfy
// every criterion and still ship an inverted condition, a swallowed exception,
// an unawaited write, or a destructive migration.
//
// Runs on EVERY review with a non-empty diff. Deliberately NOT gated on the
// repo index (unlike reviewAgainstRepo, which is skipped entirely until the
// index walk finishes): index summaries sharpen the pass when present but a
// diff-only defect review is valid, and a PR that lands mid-walk must not
// silently get zero bug detection. Same argument the security backstop makes.
//
// Precision is bought in code, not just in the prompt: every finding must carry
// a concrete `failureScenario` or normaliseDefectFindings drops it. That matters
// because blocker-severity defects gate the merge.
const DEFECT_DIFF_CAP = 120_000;

// Log action emitted when a maintainer has switched the stage off, mirroring
// the holistic stage's "disabled by workflow" row. Exported so the offline
// workflow test can assert on the exact string.
export const DEFECT_STAGE_DISABLED = "Bug detection disabled by workflow";

async function reviewDiffDefects(args: {
  review: PRReview;
  diff: string;
  touched: RepoIndexEntry[];
  endGoal: string;
  criteria: Criterion[];
  extraInstructions?: string;
}): Promise<{ defects: HolisticFinding[]; summary: string }> {
  const { touched } = args;
  const system = withMaintainerInstructions(defectsSystemPrompt(), args.extraInstructions);

  const defectDiff = truncateDiffAtHunkBoundary(args.diff, DEFECT_DIFF_CAP);
  const diffBlock =
    formatRawDiff(defectDiff.text) +
    (defectDiff.truncated ? "\n\n[diff truncated — later hunks are not shown]" : "");
  const touchedBlock = touched
    .map((e) =>
      `### ${e.path}\n` +
      `Exports: ${e.exports.join(", ") || "(none)"}\n` +
      `Summary: ${e.summary}`
    )
    .join("\n\n");
  // The criteria go in as READ-ONLY context. Without them the pass re-reports
  // "this doesn't do X" as a bug; with them plus rule 4 it knows that ground is
  // already covered and confines itself to code that is present and wrong.
  const criteriaBlock = args.criteria.length
    ? args.criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n")
    : "(none — this PR has no acceptance criteria)";

  const userText =
    `# Diff\n\`\`\`diff\n${diffBlock}\n\`\`\`\n\n` +
    `# Touched files (repo index summaries)\n${touchedBlock || "(none indexed)"}\n\n` +
    `# End goal (context only — do not score this)\n${args.endGoal || "(none)"}\n\n` +
    `# Acceptance criteria (context only — another stage scores these; do not report them as defects)\n${criteriaBlock}`;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 4096,
  });
  const parsed = tryParseJSON<{ defects?: unknown; summary?: unknown }>(raw, {});
  return {
    defects: normaliseDefectFindings(parsed.defects),
    summary: String(parsed.summary || ""),
  };
}

// Minimal vuln-like shape that both the legacy embedded Vulnerability and the
// first-class SecurityFinding rows satisfy structurally — the pre-existing
// surfacing/re-verify helpers below operate on it so the source of truth could
// move from the index to `securityFindings` without rewriting them.
export type PreexistingVulnLike = {
  id?: string;
  class: string;
  concern: string;
  path: string;
  symbol?: string;
  line?: number;
  fixPrompt?: string;    // legacy Vulnerability
  remediation?: string;  // SecurityFinding
};

// Flatten pre-existing security findings (for files this PR touches or depends
// on) into advisory findings. Forced severity "warn": these are PRE-EXISTING
// (not introduced by this PR), so they surface as context and never gate the
// merge. Deduped by path+concern and capped so a vuln-heavy file can't flood
// the review. Exported for testing alongside the review pipeline.
export function collectPreexistingVulns(vulns: PreexistingVulnLike[]): HolisticFinding[] {
  const out: HolisticFinding[] = [];
  const seen = new Set<string>();
  for (const v of vulns) {
    const key = `${v.path}::${v.concern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(formatPreexistingFinding(v));
    if (out.length >= 20) return out;
  }
  return out;
}

// "symbol:line" / "line N" locator suffix for a stored vuln, or "" when unknown.
function vulnLocator(v: PreexistingVulnLike): string {
  return v.symbol
    ? ` (${v.symbol}${v.line ? `:${v.line}` : ""})`
    : v.line
    ? ` (line ${v.line})`
    : "";
}

// Format one stored finding into an advisory "pre-existing" line:
// "[class] concern (symbol:line) — pre-existing…", forced severity "warn" (the
// PR didn't introduce it, so it never gates). Pure; reused by both the
// stored-findings collector and the re-verify step. Exported for unit testing.
export function formatPreexistingFinding(v: PreexistingVulnLike): HolisticFinding {
  const fixPrompt = v.fixPrompt || v.remediation;
  return {
    path: v.path,
    concern: `[${v.class}] ${v.concern}${vulnLocator(v)} — pre-existing in this file, not introduced by this PR.`,
    severity: "warn",
    ...(fixPrompt ? { fixPrompt } : {}),
  };
}

// Format a stored finding the PR resolved into a positive note. Same locator,
// framed as fixed; no fixPrompt (nothing to fix). severity "warn" is just the
// HolisticFinding shape — it never gates and renders in its own positive
// section. Pure; exported for unit testing.
export function formatResolvedFinding(v: PreexistingVulnLike): HolisticFinding {
  return {
    path: v.path,
    concern: `[${v.class}] ${v.concern}${vulnLocator(v)} — resolved by this PR.`,
    severity: "warn",
  };
}

// ─── Pre-existing vuln re-verification ──────────────────────────────────────
//
// The repo index is built against the DEFAULT BRANCH and is not rebuilt for an
// open PR's branch, so a vuln a PR fixes is still stored and would be re-surfaced
// verbatim on the re-review. For files the PR actually modifies (the holistic
// "touched" slice), re-check each stored vuln against the file at the PR head: a
// fixed one is dropped (and confirmed positively), a still-present one is kept.
// Files the PR doesn't touch keep the index-driven path (collectPreexistingVulns).

export type ReverifiedVulns = {
  // Vulns confirmed still present at the PR head — surfaced as before (advisory).
  stillPresent: HolisticFinding[];
  // Vulns the PR resolved — surfaced positively, never gates, nothing to fix.
  resolved: HolisticFinding[];
  // Row ids (when the inputs carried them) of the resolved findings, so the
  // caller can flip the stored rows to state "fix_ready".
  resolvedIds: string[];
};

// Pure shaper: given per-file finding lists and the model's per-file verdicts
// (path → array of {index, status}), partition every stored finding into
// still-present vs resolved. Safe default: anything not explicitly "resolved"
// (no verdict for the file, out-of-range index, any non-"resolved" status) stays
// still-present, so a real vuln is never hidden by a flaky/absent verdict.
// Deduped by path+concern across files (mirrors collectPreexistingVulns).
// Exported for offline testing.
export function partitionReverifiedVulns(
  files: Array<{ path: string; vulns: PreexistingVulnLike[] }>,
  verdictsByPath: Map<string, Array<{ index: number; status: string }>>
): ReverifiedVulns {
  const stillPresent: HolisticFinding[] = [];
  const resolved: HolisticFinding[] = [];
  const resolvedIds: string[] = [];
  const seen = new Set<string>();
  for (const e of files) {
    const verdicts = verdictsByPath.get(e.path);
    for (let i = 0; i < e.vulns.length; i++) {
      const v = e.vulns[i];
      const key = `${v.path}::${v.concern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const verdict = verdicts?.find((r) => r.index === i);
      if (verdict && verdict.status === "resolved") {
        resolved.push(formatResolvedFinding(v));
        if (v.id) resolvedIds.push(v.id);
      } else {
        stillPresent.push(formatPreexistingFinding(v));
      }
    }
  }
  return { stillPresent, resolved, resolvedIds };
}

const PREEXISTING_REVERIFY_SYSTEM =
  "You are DevAsign's pre-existing vulnerability re-verification step. A pull request modifies a file the " +
  "repository's security index previously flagged with one or more known vulnerabilities. You are given the file's " +
  "CURRENT contents at the PR head and the list of previously-known vulnerabilities (each with an index, class, " +
  "concern, and optional symbol/line). For EACH known vulnerability, decide whether it is STILL PRESENT in the current " +
  "file or has been RESOLVED by this PR. Judge only whether that specific vulnerability still exists in the code shown — " +
  "do not hunt for new issues, and do not invent vulnerabilities not in the provided list. When unsure, answer " +
  '"present" — never claim a fix you cannot actually see in the code. ' +
  'Emit ONLY JSON: {"results": [{"index": number, "status": "present"|"resolved", "evidence": string}]}. ' +
  "`index` must echo the provided vulnerability index. `evidence` is one short phrase citing the code (or its absence) that justifies the call.";

// Re-verify the stored security findings of the files this PR modifies against
// the file contents at the PR head. One blob fetch + one LLM call per touched
// file that carries stored findings (most PRs touch none). Best-effort
// throughout: a fetch or LLM failure for a file leaves it out of the verdict
// map, so partitionReverifiedVulns keeps that file's findings as still-present.
// A finding the model confirms fixed at the PR head is flipped to state
// "fix_ready" — the audit that runs after the merge confirms it "resolved".
async function reverifyTouchedPreexistingVulns(args: {
  review: PRReview;
  repo: Repository;
  install: Installation;
  findings: SecurityFinding[]; // active stored findings in files this PR touches
  extraInstructions?: string;
}): Promise<ReverifiedVulns> {
  const { review, repo, install, findings } = args;
  if (!findings.length) return { stillPresent: [], resolved: [], resolvedIds: [] };

  const byPath = new Map<string, SecurityFinding[]>();
  for (const f of findings) {
    byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
  }
  const files = [...byPath.entries()].map(([path, vulns]) => ({ path, vulns }));

  const system = withMaintainerInstructions(PREEXISTING_REVERIFY_SYSTEM, args.extraInstructions);
  const verdictsByPath = new Map<string, Array<{ index: number; status: string }>>();

  for (const e of files) {
    let content: string;
    try {
      const encodedPath = e.path.split("/").map(encodeURIComponent).join("/");
      content = await ghText(
        install.installationId,
        `/repos/${repo.owner}/${repo.name}/contents/${encodedPath}?ref=${review.headSha}`,
        { Accept: "application/vnd.github.raw" }
      );
    } catch (err) {
      console.warn(`[reverify] fetch ${e.path}@${review.headSha.slice(0, 7)} failed:`, err);
      continue; // leave unset → this file's vulns stay still-present
    }
    const vulnList = e.vulns
      .map((v, i) => {
        const loc = v.symbol ? ` symbol=${v.symbol}` : "";
        const ln = v.line ? ` line=${v.line}` : "";
        return `${i}. [${v.class}]${loc}${ln} ${v.concern}`;
      })
      .join("\n");
    const userText =
      `# File: ${e.path} (current contents at PR head)\n\`\`\`\n${content.slice(0, 40_000)}\n\`\`\`\n\n` +
      `# Previously-known vulnerabilities in this file\n${vulnList}`;
    try {
      const raw = await complete({
        system,
        cacheSystem: true,
        messages: [{ role: "user", content: userText }],
        maxTokens: 1000,
      });
      const parsed = tryParseJSON<{ results?: unknown }>(raw, {});
      const results = Array.isArray(parsed.results)
        ? parsed.results
            .map((r: any) => ({ index: Number(r?.index), status: String(r?.status ?? "").trim().toLowerCase() }))
            .filter((r) => Number.isInteger(r.index))
        : [];
      verdictsByPath.set(e.path, results);
    } catch (err) {
      console.warn(`[reverify] llm ${e.path} failed:`, err);
      // leave unset → this file's vulns stay still-present (safe default)
    }
  }

  const partitioned = partitionReverifiedVulns(files, verdictsByPath);
  // Flip resolved-at-head findings to fix_ready (idempotent: skip rows already
  // there). The Security page shows "fix PR open"; the post-merge audit is what
  // moves them to "resolved".
  const now = Date.now();
  for (const id of partitioned.resolvedIds) {
    const f = db.find("securityFindings", (x) => x.id === id);
    if (!f || f.state === "fix_ready") continue;
    db.update("securityFindings", (x) => x.id === id, {
      state: "fix_ready",
      stateReason: `Fix verified on PR #${review.prNumber}`,
      activity: [
        ...(f.activity ?? []),
        {
          at: now,
          kind: "state_change" as const,
          detail: `Fix verified at the head of PR #${review.prNumber} — resolves when merged`,
          actor: "audit-agent",
        },
      ].slice(-50),
    });
  }
  return partitioned;
}

// Wording-tolerant identity for a finding: same file, same substance. Two
// passes that spot the same bug phrase it differently ("returns before the
// write lands" vs "Returns before the write lands."), so raw string equality
// under-dedupes. normalizeSlug drops case and punctuation; the prefix keeps a
// shared opening clause from collapsing genuinely different findings.
function findingKey(f: Pick<HolisticFinding, "path" | "concern">): string {
  return `${normalizeSlug(f.path ?? "")}::${normalizeSlug(f.concern).slice(0, 80)}`;
}

// Dedupe HolisticFindings by normalized path+concern and cap the count. Two
// callers: merging the re-verified touched-file vulns with the index-driven
// dependent-file ones (reproducing collectPreexistingVulns' single-source
// dedupe+cap), and dropping defect-pass findings the holistic pass already
// reported. `against` seeds the seen-set with findings that are already being
// rendered elsewhere, so the returned list only contains what's genuinely new.
export function dedupeAndCapFindings(
  findings: HolisticFinding[],
  cap: number,
  against: HolisticFinding[] = []
): HolisticFinding[] {
  const out: HolisticFinding[] = [];
  const seen = new Set<string>(against.map(findingKey));
  for (const f of findings) {
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    if (out.length >= cap) break;
  }
  return out;
}

// ─── New-commit intent review ───────────────────────────────────────────────
//
// On a re-review triggered by a fresh push, the original acceptance criteria are
// frozen and reviewDiff anchors on prior verdicts, so new work a follow-up commit
// introduces is never judged against the commit's OWN stated intent. This stage
// closes that gap: it diffs only the delta since the last reviewed sha, synthesizes
// acceptance criteria for any new checkable promises (appended so they gate), and
// produces an intent-vs-implementation assessment that gives fresh feedback even
// when the original criteria are unchanged.

export type CommitIntentReview = {
  // New, independently checkable acceptance criteria the new commits promise.
  // Appended via appendAddedCriteria so reviewDiff scores them and unmet ones gate.
  addedCriteria: string[];
  // Advisory per-commit notes (forced "warn"): where the delta doesn't match a
  // commit message or the new code introduces a concern.
  intentFindings: HolisticFinding[];
  // One-paragraph narrative of what the new commits did and whether they landed.
  summary: string;
};

// Shape the (untrusted) intent-review LLM output: trim/drop/cap addedCriteria,
// force intentFindings to advisory "warn" (gating rides the criteria, not these
// notes), and coerce the summary. Pure/exported for offline unit testing.
export function normalizeCommitIntent(parsed: {
  addedCriteria?: unknown;
  intentFindings?: unknown;
  summary?: unknown;
}): CommitIntentReview {
  const addedCriteria = Array.isArray(parsed.addedCriteria)
    ? parsed.addedCriteria.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 10)
    : [];
  const intentFindings = normaliseFindings(parsed.intentFindings).map((f) => ({ ...f, severity: "warn" as const }));
  return { addedCriteria, intentFindings, summary: String(parsed.summary || "") };
}

// Pure gate: run the new-commit intent review only on a re-review that ingested
// genuinely new commits (a new head sha) for a PR that already has criteria.
// Skips first reviews, same-sha reruns (manual rerun/reopen), and rows with no
// recorded last-reviewed sha (legacy / first pass). Exported for unit testing.
export function shouldReviewNewCommits(args: {
  startedNewCommit: boolean;
  lastReviewedSha?: string | null;
  headSha: string;
  priorCriteriaCount: number;
}): boolean {
  const { startedNewCommit, lastReviewedSha, headSha, priorCriteriaCount } = args;
  return (
    startedNewCommit &&
    !!lastReviewedSha &&
    lastReviewedSha !== headSha &&
    priorCriteriaCount > 0
  );
}

// Fetch the incremental delta between the last reviewed sha and the new head:
// the new commits (messages = author intent) and a diff of ONLY those commits.
// One compare call carries both `commits[]` and `files[].patch`. Best-effort:
// returns null on any failure (e.g. force-push where base isn't reachable) so the
// caller falls back to the cumulative review with no regression.
async function fetchIncrementalDelta(
  installationId: number,
  repo: { owner: string; name: string },
  base: string,
  head: string
): Promise<{ commits: Array<{ sha: string; message: string }>; diff: string } | null> {
  try {
    const cmp = await gh<{
      status?: string;
      commits?: Array<{ sha: string; commit?: { message?: string } }>;
      files?: Array<{ filename: string; patch?: string }>;
    }>(installationId, `/repos/${repo.owner}/${repo.name}/compare/${base}...${head}`);
    // Only run the incremental review for fast-forward pushes. A rebase/force-push
    // makes base and head "diverged"; the compare then walks back to their merge
    // base and reports the rebased-onto base-branch commits as "new", which the
    // model would mistake for the author's intent and synthesize criteria the
    // cumulative diff can't satisfy. Returning null falls back to the cumulative
    // review with no regression.
    if (cmp.status !== "ahead") {
      return null;
    }
    const commits = (cmp.commits ?? []).map((c) => ({
      sha: c.sha,
      message: c.commit?.message || "",
    }));
    // Reassemble a unified-diff view from per-file patches, capped like the
    // holistic pass. GitHub omits `patch` for very large/binary files; list those
    // by name so the model still sees they changed.
    const parts = (cmp.files ?? []).map((f) =>
      f.patch
        ? `diff --git a/${f.filename} b/${f.filename}\n${f.patch}`
        : `diff --git a/${f.filename} b/${f.filename}\n(omitted — large or binary file)`
    );
    return { commits, diff: parts.join("\n\n").slice(0, 40_000) };
  } catch (err) {
    console.warn(`[ingest] compare ${base.slice(0, 7)}...${head.slice(0, 7)} failed:`, err);
    return null;
  }
}

async function reviewNewCommits(args: {
  review: PRReview;
  endGoal: string;
  existingCriteria: Criterion[];
  newCommits: Array<{ sha: string; message: string }>;
  incrementalDiff: string;
  extra?: string;
}): Promise<CommitIntentReview> {
  const system = withMaintainerInstructions(
    "You are DevAsign's new-commit intent review step. A pull request that already has acceptance criteria just " +
    "received NEW commits. You are given those commits' messages (the author's stated intent), a diff of ONLY those " +
    "new commits (the delta since the last review), the PR's end goal, and the existing acceptance criteria. Do two jobs:\n" +
    "1. addedCriteria: derive NEW, independently checkable acceptance criteria for work these commits introduce that the " +
    "existing criteria don't already cover. Be conservative — only concrete, verifiable promises the commit messages and " +
    "diff actually make (e.g. \"retries failed uploads on 5xx\"). A pure refactor, cleanup, or commit that makes no new " +
    "verifiable promise adds nothing. Never restate an existing criterion, and never invent requirements to look thorough.\n" +
    "2. intentFindings: for each new commit, judge whether the delta diff actually accomplishes what its message says, and " +
    "flag concrete problems the new code introduces. These are advisory notes — the addedCriteria are what gate the merge.\n" +
    "Also write a one-paragraph `summary` of what the new commits did and whether they land their stated intent.\n" +
    'Emit ONLY JSON: {"addedCriteria": [string], "intentFindings": [{"path": string?, "concern": string, "severity": "blocker"|"warn", "fixPrompt": string}], "summary": string}. ' +
    "Quote the commit sha or message when a finding refers to a specific commit. Prefer empty arrays over padding. " +
    "Each intentFinding MUST include a `fixPrompt` the user can paste into another AI coding agent (Cursor / Claude Code / Codex). Use this exact template:\n" +
    "Fix: <one-line summary>\n\n" +
    "File: <path or 'n/a'>\n" +
    "Symbol: <function/class/component name, or 'n/a'>\n\n" +
    "Issue:\n<2-3 sentence description: the commit's stated intent and how the diff falls short or what it breaks>\n\n" +
    "Expected behavior:\n<1-2 sentences: what should happen once fixed>\n\n" +
    "Suggested approach:\n<concrete steps to fix>\n\n" +
    "Relevant diff:\n```diff\n<the exact hunk this refers to, copied verbatim from the delta diff>\n```\n" +
    "Quote the hunk verbatim — never invent code. Omit the 'Relevant diff' section only when the finding doesn't map to a hunk.", args.extra);

  const commitsBlock = args.newCommits
    .map((c) => `### ${c.sha.slice(0, 7)}\n${(c.message || "(no message)").slice(0, 2000)}`)
    .join("\n\n");
  const criteriaBlock = args.existingCriteria.map((c) => `- ${c.id}: ${c.text}`).join("\n") || "(none)";
  const userText =
    `# PR\n${args.review.prTitle}\n\n` +
    `# End goal\n${args.endGoal || "(none)"}\n\n` +
    `# Existing acceptance criteria\n${criteriaBlock}\n\n` +
    `# New commits (stated intent)\n${commitsBlock}\n\n` +
    `# Delta diff (only the new commits)\n\`\`\`diff\n${args.incrementalDiff.slice(0, 40_000)}\n\`\`\``;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 1800,
  });
  const parsed = tryParseJSON<{ addedCriteria?: unknown; intentFindings?: unknown; summary?: unknown }>(raw, {});
  return normalizeCommitIntent(parsed);
}

// ─── DEVASIGN.md guidance ───────────────────────────────────────────────────
//
// Check the diff against the team's own DEVASIGN.md conventions. Each doc was
// already scoped to the changed files it governs (devasignDocsForChangedFiles);
// here we ask the model for two advisory, nit-level outputs:
//   • violations — rules the diff NEWLY breaks (→ conventionFindings)
//   • docUpdates — DEVASIGN.md statements the diff makes outdated (→ docDrift)
// Both are forced to severity "nit": surfaced as nitpicks, never gate a merge.
async function reviewAgainstDevasignDocs(args: {
  review: PRReview;
  diff: string;
  docs: DevasignDoc[];
  scopes: DevasignScope[];
  extraInstructions?: string;
}): Promise<{ conventionFindings: HolisticFinding[]; docDriftFindings: HolisticFinding[]; summary: string }> {
  const { docs, scopes } = args;
  if (!scopes.length) return { conventionFindings: [], docDriftFindings: [], summary: "" };
  const system = withMaintainerInstructions(devasignDocsSystemPrompt(), args.extraInstructions);

  const docByPath = new Map(docs.map((d) => [d.path, d.content]));
  const docsBlock = scopes
    .map((s) => {
      const scopeLabel = s.dir === "" ? "(repo root — governs all files)" : `${s.dir}/**`;
      const content = docByPath.get(s.docPath) ?? "";
      return (
        `### ${s.docPath}\n` +
        `Scope: ${scopeLabel}\n` +
        `Governs these changed files:\n${s.governedFiles.map((f) => `- ${f}`).join("\n")}\n\n` +
        `Rules:\n${content || "(empty)"}`
      );
    })
    .join("\n\n---\n\n");

  const docsDiff = truncateDiffAtHunkBoundary(args.diff, 40_000);
  const userText =
    `# Diff\n\`\`\`diff\n${formatRawDiff(docsDiff.text)}${docsDiff.truncated ? "\n[diff truncated — later hunks omitted]" : ""}\n\`\`\`\n\n` +
    `# DEVASIGN.md files governing this PR's changed files\n${docsBlock}`;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 4096,
  });
  const parsed = tryParseJSON<{ violations?: unknown; docUpdates?: unknown; summary?: unknown }>(raw, {});
  // Force "nit" regardless of model output — DEVASIGN.md findings are uniformly
  // advisory (the same way pre-existing vulns are forced to "warn").
  const toNit = (f: HolisticFinding): HolisticFinding => ({ ...f, severity: "nit" });
  return {
    conventionFindings: normaliseFindings(parsed.violations).map(toNit),
    docDriftFindings: normaliseFindings(parsed.docUpdates).map(toNit),
    summary: String(parsed.summary || ""),
  };
}

// Coerce a model-emitted finding `line` to a positive integer or drop it.
function coerceFindingLine(v: unknown): number | undefined {
  const n = Number(v);
  return v != null && Number.isInteger(n) && n > 0 ? n : undefined;
}

function normaliseFindings(input: unknown): HolisticFinding[] {
  if (!Array.isArray(input)) return [];
  const out: HolisticFinding[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const concern = String((item as any).concern || "").trim();
    if (!concern) continue;
    const rawSev = (item as any).severity;
    const sev: HolisticFinding["severity"] =
      rawSev === "blocker" ? "blocker" : rawSev === "nit" ? "nit" : "warn";
    const path = (item as any).path;
    const fixPrompt = (item as any).fixPrompt;
    const line = coerceFindingLine((item as any).line);
    const suggestedChange = coerceSuggestedChange((item as any).suggestedChange);
    out.push({
      concern,
      severity: sev,
      ...(typeof path === "string" && path ? { path } : {}),
      ...(typeof fixPrompt === "string" && fixPrompt ? { fixPrompt } : {}),
      ...(line ? { line } : {}),
      ...(suggestedChange ? { suggestedChange } : {}),
    });
  }
  return out;
}

// Caps on the defect pass's free-text fields, mirroring the clamping
// buildFindingRows applies to security findings — one verbose finding must not
// be able to blow up a PR comment or a log row.
const DEFECT_CONCERN_CAP = 1200;
const DEFECT_SCENARIO_CAP = 800;
const DEFECT_FIX_PROMPT_CAP = 6000;
const DEFECT_CLASS_CAP = 60;
export const DEFECT_FINDING_CAP = 12;

// Normalize the defect pass's output. Unlike its sibling normalisers this one
// is a FILTER, not just a coercer: a finding with no concrete `failureScenario`
// is DROPPED rather than downgraded. That is the precision gate — the same
// trick security/agent.ts uses when it drops findings without a 3-step exploit
// narrative — and it is what makes it safe for a blocker here to stop a merge.
// Unrecognized severities fall back to "warn", never "blocker", so a garbled
// response can't gate. Exported for offline testing.
export function normaliseDefectFindings(input: unknown): HolisticFinding[] {
  if (!Array.isArray(input)) return [];
  const out: HolisticFinding[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const concern = String((item as any).concern || "").trim();
    if (!concern) continue;
    // The gate: no concrete failure scenario means the model is speculating.
    const failureScenario = String((item as any).failureScenario || "").trim();
    if (!failureScenario) continue;
    const rawSev = (item as any).severity;
    const severity: HolisticFinding["severity"] =
      rawSev === "blocker" ? "blocker" : rawSev === "nit" ? "nit" : "warn";
    const path = (item as any).path;
    const fixPrompt = (item as any).fixPrompt;
    const defectClass = (item as any).defectClass;
    const line = coerceFindingLine((item as any).line);
    const suggestedChange = coerceSuggestedChange((item as any).suggestedChange);
    out.push({
      concern: concern.slice(0, DEFECT_CONCERN_CAP),
      failureScenario: failureScenario.slice(0, DEFECT_SCENARIO_CAP),
      severity,
      ...(typeof path === "string" && path ? { path: path.slice(0, 400) } : {}),
      ...(typeof defectClass === "string" && defectClass.trim()
        ? { defectClass: defectClass.trim().slice(0, DEFECT_CLASS_CAP) }
        : {}),
      ...(typeof fixPrompt === "string" && fixPrompt
        ? { fixPrompt: fixPrompt.slice(0, DEFECT_FIX_PROMPT_CAP) }
        : {}),
      ...(line ? { line } : {}),
      ...(suggestedChange ? { suggestedChange } : {}),
    });
    if (out.length >= DEFECT_FINDING_CAP) break;
  }
  return out;
}

// Security findings use the 4-tier severity model (the Security page's model).
// The legacy 2-tier field is derived — critical → "blocker", everything else →
// "warn" — so renderers and the verdict gate stay unchanged while gating
// tightens to exactly "critical gates". Exported for offline testing.
export function normaliseSecurityFindings(input: unknown): HolisticFinding[] {
  if (!Array.isArray(input)) return [];
  const out: HolisticFinding[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const concern = String((item as any).concern || "").trim();
    if (!concern) continue;
    const tier = normalizeSeverity((item as any).severity);
    const path = (item as any).path;
    const fixPrompt = (item as any).fixPrompt;
    const line = coerceFindingLine((item as any).line);
    const suggestedChange = coerceSuggestedChange((item as any).suggestedChange);
    out.push({
      concern,
      severity: severityToLegacy(tier),
      securitySeverity: tier,
      ...(typeof path === "string" && path ? { path } : {}),
      ...(typeof fixPrompt === "string" && fixPrompt ? { fixPrompt } : {}),
      ...(line ? { line } : {}),
      ...(suggestedChange ? { suggestedChange } : {}),
    });
  }
  return out;
}

// ─── Deferred / incomplete-work detection ──────────────────────────────────
//
// The complaint this addresses: a coding agent agrees to a design, then during
// implementation quietly punts part of it and buries the admission in a code
// comment ("deferred to a follow-up", a TODO, a stub) instead of telling the
// author. We mine the diff's own *added* lines for those self-admissions, then
// — only if any surface — ask the model which ones are a real gap against what
// the PR promised. Advisory: findings never gate the merge; they just need to
// be seen on time.

type DeferralCandidate = { path: string; lineText: string; marker: string };

// Case-insensitive markers that betray a self-admitted punt in added code.
// Tuned for recall on the agent's own words; detectDeferredWork is the
// precision filter that drops benign matches (an unrelated pre-existing TODO, a
// marker inside a logging string, a stray "pending" in prose).
const DEFERRAL_MARKERS: RegExp[] = [
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bHACK\b/i,
  /\bXXX\b/,
  /not[\s_-]?implemented/i,
  /\bunimplemented\b/i,
  /NotImplemented(?:Error|Exception)?/,
  /\bfor now\b/i,
  /\bfor the (?:time being|moment)\b/i,
  /\bin the future\b/i,
  /\bfuture work\b/i,
  /\bfollow[\s-]?up\b/i,
  /\bdefer(?:red|ring|s)?\b/i,
  /\bplaceholder\b/i,
  /\bstub(?:bed|s)?\b/i,
  /\btemporar(?:y|ily)\b/i,
  /\bout of scope\b/i,
  /\brevisit\b/i,
  /(?:won['’]t|will not|doesn['’]t|does not|can['’]t|cannot)\s+(?:yet\s+)?(?:support|handle|implement)/i,
  /\bcurrently (?:only|does not|doesn['’]t)\b/i,
  /\bwill (?:be )?(?:add|implement|support|handl)/i,
  /\bleft as (?:an )?exercise\b/i,
  /\bpending\b/i,
  /\bpartial(?:ly)?\s+(?:implement|support)/i,
  /\bnot (?:yet )?(?:done|handled|supported|implemented)\b/i,
];

const DEFERRAL_CANDIDATE_CAP = 40;

// Pure pre-scan: walk the unified diff's *added* lines (tracking the file each
// hunk belongs to) and collect the ones that trip a deferral marker. Exported
// so it can be unit-tested without an LLM round-trip.
export function scanDeferralCandidates(diff: string): DeferralCandidate[] {
  const out: DeferralCandidate[] = [];
  let currentPath = "";
  for (const raw of diff.split("\n")) {
    // "+++ b/path" is the post-image path for the following hunk; "+++ /dev/null"
    // marks a deletion (currentPath stays whatever it was — we skip its lines
    // below since deletions have no added content).
    const header = raw.match(/^\+\+\+ b\/(.+)$/);
    if (header) {
      currentPath = header[1].trim();
      continue;
    }
    // Added lines only: a single leading "+", not the "+++" file header.
    if (raw[0] !== "+" || raw.startsWith("+++")) continue;
    const added = raw.slice(1);
    const hit = DEFERRAL_MARKERS.find((re) => re.test(added));
    if (!hit) continue;
    out.push({
      path: currentPath,
      lineText: added.trim().slice(0, 200),
      marker: (added.match(hit)?.[0] || "").trim(),
    });
    if (out.length >= DEFERRAL_CANDIDATE_CAP) break;
  }
  return out;
}

// Assemble "what the PR promised" — the yardstick each self-admitted deferral is
// measured against: the end goal, the acceptance criteria, and the PR/issue
// description text already ingested into the context.
function buildPromiseText(endGoal: string, criteria: Criterion[], context: Context): string {
  const parts: string[] = [];
  if (endGoal && endGoal !== NEUTRAL_ENDGOAL) parts.push(`## End goal\n${endGoal}`);
  if (criteria.length) {
    parts.push(`## Acceptance criteria\n${criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n")}`);
  }
  const promiseSources = context.sources.filter(
    (s) => s.kind === "github_pr" || s.kind === "github_issue_primary" || s.kind === "github_issue"
  );
  for (const s of promiseSources.slice(0, 4)) {
    parts.push(`## ${s.kind} (${s.ref})\n${s.text.slice(0, 2000)}`);
  }
  return parts.join("\n\n");
}

// Regex-gated LLM pass. Given what the PR promised and the candidate marker
// lines from the pre-scan, decide which candidates are genuine self-admitted
// deferrals/scope-cuts and whether each contradicts the promise. Returns
// advisory findings (severity forced to "warn" so they never gate the merge,
// like the other advisory buckets). Exported for testing alongside
// scanDeferralCandidates.
export async function detectDeferredWork(args: {
  diff: string;
  promise: string;
  candidates: DeferralCandidate[];
  extraInstructions?: string;
}): Promise<HolisticFinding[]> {
  const { diff, promise, candidates } = args;
  if (!candidates.length) return [];
  const system = withMaintainerInstructions(deferredWorkSystemPrompt(), args.extraInstructions);

  const candidateBlock = candidates
    .map((c, i) => `${i + 1}. ${c.path || "(unknown file)"} — \`${c.lineText}\``)
    .join("\n");

  const defDiff = truncateDiffAtHunkBoundary(diff, 40_000);
  const userText =
    `# What this PR promised\n${promise || "(no explicit promise on record — compare against the PR's apparent intent)"}\n\n` +
    `# Candidate self-admissions found in the added code\n${candidateBlock}\n\n` +
    `# Diff\n\`\`\`diff\n${formatRawDiff(defDiff.text)}${defDiff.truncated ? "\n[diff truncated — later hunks omitted]" : ""}\n\`\`\``;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 4096,
  });
  const parsed = tryParseJSON<{ deferrals?: unknown }>(raw, { deferrals: [] });
  // Advisory: force "warn" so a deferral never flips the merge status. The
  // model's contradiction judgment is preserved in the `concern` prefix.
  return normaliseFindings(parsed.deferrals).map((f) => ({ ...f, severity: "warn" as const }));
}
