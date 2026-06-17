// Review pipeline. Spec: devasign.md §5.
//   a. Context ingestion (GitHub diff + Linear/Slack/Figma/Loom/PDF attachments)
//   b. Criteria synthesis ("End goal")
//   c. Review (multimodal LLM compares diff vs each criterion)
//   d. Output (post Check Run + PR review; write reviewLogs; broadcast)
//   e. Eval (LLM-as-judge; out-of-band, not in this hot path)
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { dismissPRReview, dispatchWorkflow, gh, postPRCommentReturningId, updatePRComment } from "../github/app.js";
import { progressCommentBody, reviewFailedCommentBody, verdictCommentBody } from "./progress-comment.js";
import { complete, currentUsage, detectVideoProvider, summarizeLinearFile, summarizeVideo, withModel, withUsage, type VideoSummary } from "../llm.js";
import { track } from "../statsig.js";
import { broadcastVerdict } from "../integrations/broadcast.js";
import { notifyForReview } from "../notifications.js";
import { config } from "../config.js";
import { type MaintainerComment } from "../queue.js";
import {
  downloadLinearFile,
  fetchLinearIssueContext,
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
import type { Criterion, Installation, Integration, PRReview, PRReviewStatus, RepoIndexEntry, Repository, ReviewLogEntry, ReviewLogKind, Task, User } from "../types.js";
import { modelForPlan, planForUser, privateRepoBlocked } from "../billing/plans.js";
import {
  appendAddedCriteria,
  buildCriteriaSection,
  splitForComment,
  type PriorVerdict,
} from "./criteria-format.js";
import { effectiveWorkflow } from "./workflow.js";
import { buildGuidanceSection } from "./guidance.js";
import { resolveReviewEvent, withMaintainerInstructions } from "./decisions.js";

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
  | "consistency"
  | "deferral"
  // DEVASIGN.md findings: a convention the diff newly violates, and a
  // DEVASIGN.md statement the diff makes outdated (docs need updating).
  | "convention"
  | "docDrift"
  | "suggestion";

function emitFindingLog(
  reviewId: string,
  category: Exclude<FindingCategory, "suggestion">,
  finding: { path?: string; concern: string; severity: "blocker" | "warn" | "nit"; fixPrompt?: string }
) {
  const titleByCategory: Record<typeof category, string> = {
    regression: "Possible regression",
    criticalError: "Critical error",
    security: "Security finding",
    consistency: "Consistency deviation",
    deferral: "Deferred / incomplete work",
    convention: "DEVASIGN.md violation",
    docDrift: "DEVASIGN.md needs updating",
  };
  log(reviewId, "finding", titleByCategory[category], {
    detail: finding.concern,
    meta: {
      category,
      severity: finding.severity,
      ...(finding.path ? { path: finding.path } : {}),
      title: titleByCategory[category],
      body: finding.concern,
      ...(finding.fixPrompt ? { fixPrompt: finding.fixPrompt } : {}),
    },
  });
}

function emitSuggestionLog(reviewId: string, s: ReviewSuggestion) {
  // Compose a body that includes rationale and (optionally) the codeExample so
  // the timeline shows the same information the GitHub PR body does.
  const bodyParts = [s.rationale];
  if (s.codeExample) {
    const fence = codeFence(s.codeExample);
    bodyParts.push(`${fence}\n${s.codeExample}\n${fence}`);
  }
  log(reviewId, "finding", s.title || "Suggested change", {
    detail: s.rationale,
    meta: {
      category: "suggestion" as FindingCategory,
      severity: "warn" as const,
      criterionId: s.criterionId,
      title: s.title,
      body: bodyParts.join("\n\n"),
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
  const reviewUser = analyticsUser(install?.userId);

  return withModel(reviewModel, () => withUsage(async () => {
  setStatus(review.id, { status: "reviewing" });
  log(review.id, "review", "Pipeline started");

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
    const holistic = wf.stages.holistic
      ? gatherHolisticContext(repo, context.diff)
      : { entries: [], touchedCount: 0, dependentCount: 0, manifest: [] };
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
    if (context.linearSeedCriteria.length && review.criteria.length === 0) {
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
      return { ...c, met: m?.met ?? null, evidence: m?.evidence ?? null };
    });
    const allMet = filledCriteria.every((c) => c.met === true);
    // Criteria an earlier commit satisfied that this diff broke — persisted and
    // rendered as "previously met, now broken" so the developer sees the
    // regression instead of it being lumped in with never-met criteria.
    const regressedCriteriaIds = splitForComment(filledCriteria, priorVerdicts).regressed.map(
      (c) => c.id
    );

    // c.1 Whole-repo review: ask Opus to check the diff against the repo index
    // for regressions, critical errors, and security flaws. Skipped when the
    // index hasn't been built yet (e.g. a PR landed before the initial walk
    // finished); in that case we fall back to the criteria-only verdict.
    let holisticVerdict: HolisticVerdict = EMPTY_HOLISTIC;
    let hasBlocker = false;
    if (holistic.entries.length || holistic.manifest.length) {
      holisticVerdict = await reviewAgainstRepo({ review, diff: context.diff, holistic, extraInstructions: wf.prompts?.holistic });
      hasBlocker = [
        ...holisticVerdict.regressions,
        ...holisticVerdict.criticalErrors,
        ...holisticVerdict.securityFindings,
      ].some((f) => f.severity === "blocker");
      log(
        review.id,
        "holistic",
        hasBlocker ? "Holistic review found blockers" : "Holistic review clean",
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

    const status: PRReviewStatus = allMet && !hasBlocker ? "passed" : "changes_requested";
    setStatus(review.id, {
      criteria: filledCriteria,
      verdict: verdict.summary,
      status,
      // Persist the regressions (met by an earlier commit, broken by this diff)
      // so the GitHub comment and the in-app timeline can flag them.
      regressedCriteriaIds,
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
    const { event: reviewEvent, postConversationReview, includeEndGoalCTA, downgradedToComment } =
      resolveReviewEvent({
        status,
        specless,
        blocking: wf.verdict.blocking,
        endGoalAlreadyRequested: !!task.endGoalRequestedAt,
      });
    if (downgradedToComment) {
      log(review.id, "verdict", "Comment-only mode — merge not blocked", {
        detail: "Workflow set to advisory: posting a COMMENT instead of REQUEST_CHANGES.",
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
        deferrals: holisticVerdict.deferrals.length,
        convention_nits: holisticVerdict.conventionFindings.length,
        doc_drift: holisticVerdict.docDriftFindings.length,
        line_comments: verdict.comments.length,
        suggestions: verdict.suggestions.length,
        video_count: context.videos.length,
        is_first_review: priorVerdicts.size === 0,
        is_new_commit: startedNewCommit,
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

type IngestedSource = { kind: string; ref: string; text: string };
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

// System prompt for criteria synthesis. Pure/exported so the prompt contract can
// be unit-tested. Keep the literal "criteria synthesis" marker — the offline LLM
// mock keys off it.
export function criteriaSynthesisSystemPrompt(hasAuthoritativeSpec: boolean): string {
  return (
    "You are DevAsign's criteria synthesis step. Read the ticket and surrounding context, then emit a JSON object: " +
    "{\"endGoal\": string, \"criteria\": [{\"id\": string, \"text\": string}]}. " +
    "The endGoal is one sentence summarising what success looks like. Each criterion is independently checkable. " +
    "Sources labelled `github_issue_primary` or `linear_issue_primary` are the canonical job-to-be-done (the issue the " +
    "PR closes/fixes); treat their description as authoritative. `linear_subissue` rows are sub-tasks of that issue and " +
    "`linear_comment` rows are discussion on it — treat both as authoritative detail. `linear_attachment` rows are linked " +
    "resources (Figma, docs, the PR); `linear_file` rows summarise files attached to the ticket (PDFs/images); " +
    "`linear_project_update` rows are project-status background. `github_issue` rows are secondary " +
    "background. `video_summary` rows describe what a Loom/YouTube/Vimeo showed; use them when the issue/PR text was vague. " +
    "`repo_guidance` rows are binding review guidelines the maintainer attached to this repository — treat them as " +
    "authoritative requirements and fold every applicable point into the criteria. " +
    "A `Commit messages` section, when present, lists the messages of the commits that make up the PR; when the PR's own " +
    "description is thin or empty, treat the commit messages as the author's statement of intent and use them to understand " +
    "what the change set out to do." +
    (hasAuthoritativeSpec
      ? ""
      : " IMPORTANT: This PR has NO linked issue and NO attached specification. Derive acceptance criteria ONLY from " +
        "explicit, checkable claims the PR's own title, description, and commit messages actually make (e.g. \"fixes flaky " +
        "uploads\", \"adds retry on 5xx\"). When the description is thin or empty, fall back to the commit messages for the " +
        "PR's intent. If neither the description nor the commit messages make any verifiable promise, return an EMPTY " +
        "`criteria` array and a brief, neutral one-sentence `endGoal` describing what the PR appears to do. Never invent " +
        "acceptance criteria just to have something to check, and never turn vague phrasing into a hard requirement.") +
    " Never use emoji in any text you output."
  );
}

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
}): Promise<{ endGoal: string; criteria: Criterion[] }> {
  const { title, sources, hasAuthoritativeSpec, commits, extraInstructions } = args;
  const system = withMaintainerInstructions(
    criteriaSynthesisSystemPrompt(hasAuthoritativeSpec),
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
  const criteria: Criterion[] = (parsed.criteria || []).map((c: any, i: number) => ({
    id: String(c.id || `c${i + 1}`),
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
function isLinearFileUrl(url: string): boolean {
  return /\blinear\.app\b/i.test(url) || /\.(pdf|png|jpe?g|webp|gif)(?:\?|#|$)/i.test(url);
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
    const id = String(c.id || `c${i + 1}`);
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
  codeExample?: string;
  // Self-contained prompt the user can paste into an external AI coding agent
  // (Cursor / Claude Code / Codex) to land the fix. Includes the relevant
  // diff hunk inline so the prompt is actionable without repo access.
  fixPrompt?: string;
};

async function reviewDiff(
  review: PRReview,
  context: Context,
  criteria: Criterion[],
  prior: Map<string, PriorVerdict> = new Map(),
  extra?: string
): Promise<{
  summary: string;
  criteria: Array<{ id: string; met: boolean; evidence: string }>;
  comments: Array<{ path: string; line: number; body: string }>;
  suggestions: ReviewSuggestion[];
}> {
  const system = withMaintainerInstructions(
    "You are DevAsign's PR review step. Evaluate the diff against each criterion. Emit JSON: " +
    "{\"verdict\": \"passed\"|\"changes_requested\", \"summary\": string, " +
    "\"criteria\": [{\"id\": string, \"met\": boolean, \"evidence\": string}], " +
    "\"comments\": [{\"path\": string, \"line\": number, \"body\": string}], " +
    "\"suggestions\": [{\"criterionId\": string, \"title\": string, \"rationale\": string, \"codeExample\"?: string, \"fixPrompt\": string}]}. " +
    "Be specific about evidence — quote the diff where possible. " +
    "For every criterion you mark met:false, `evidence` MUST be a concrete, non-empty 1-2 sentence explanation of why it is not met: name the function/file and state what the diff currently does (or fails to do) relative to the requirement. Never leave it empty, and never just restate the criterion text back. " +
    // Stateful re-review: each criterion carries the verdict it got on an
    // earlier commit in this same PR. We anchor on that to stop a follow-up
    // commit (e.g. a security fix) from re-failing work earlier commits already
    // landed — genuine regressions still flip it, and the whole-repo pass is an
    // independent backstop for breakage/security.
    "Some criteria are annotated with the verdict they received in a PREVIOUS review of an earlier commit in THIS SAME pull request; the diff below is cumulative and already includes those earlier commits. " +
    "For a criterion marked '[previously SATISFIED by an earlier commit in this PR]', keep met:true UNLESS the current diff shows that satisfying code was removed, reverted, or broken — only then set met:false, and cite the specific hunk as evidence. " +
    "Never flip a previously-satisfied criterion to unmet merely because it is not the focus of the latest commit, or because you cannot find its evidence in a truncated diff. " +
    "Evaluate criteria marked '[previously NOT met — re-evaluate]' or '[not yet evaluated]' fresh against the full diff. " +
    "If the diff is marked truncated, treat any criterion you cannot verify as unchanged from its previous verdict rather than newly failing it. " +
    "If the criteria list is empty, do NOT invent criteria or acceptance checks — review only for concrete, " +
    "evidence-backed defects in the diff, and if it is sound return empty `comments` and `suggestions` with a brief, " +
    "positive `summary`. Never manufacture issues to appear thorough. " +
    "For every unmet criterion, include one suggestion describing the smallest practical patch the developer " +
    "could ship in a follow-up commit; prefer best-practice idioms already used in the diff. " +
    "`codeExample` is optional and must be a minimal snippet, never a full file. " +
    "Inline `comments` annotate specific diff lines; only emit them when the comment ties to a concrete line. " +
    // fixPrompt: a copy-pasteable prompt for an external AI coding agent
    // (Cursor / Claude Code / Codex). Self-contained — must include the
    // relevant diff hunk verbatim so the user's agent can act without repo
    // access. Strict template:
    "Each suggestion MUST include a `fixPrompt` string the user can paste into another AI coding agent. " +
    "Use this exact template (preserve newlines and the inner ```diff fence):\n" +
    "Fix: <one-line summary>\n\n" +
    "File: <path>\n" +
    "Symbol: <function/class/component name, or 'n/a'>\n\n" +
    "Issue:\n<2-3 sentence concern description>\n\n" +
    "Expected behavior:\n<1-2 sentences: what should happen once fixed so the criterion passes>\n\n" +
    "Suggested approach:\n<concrete steps to fix>\n\n" +
    "Relevant diff:\n```diff\n<the exact hunk this finding refers to, copied verbatim from the PR diff in the user message>\n```\n" +
    "Quote the hunk verbatim — never invent code that isn't in the diff. Omit the 'Relevant diff' section only when the finding doesn't map to a specific hunk. " +
    "Never use emoji in any text you output.", extra);
  // Keep the head of the diff; mark when we drop the tail so the model reads a
  // missing hunk as "not shown" rather than "not done" (which, combined with the
  // prior-verdict anchoring above, is what stops truncation from regressing a
  // previously-met criterion).
  const DIFF_CAP = 60_000;
  const diffTruncated = context.diff.length > DIFF_CAP;
  const diffBody =
    context.diff.slice(0, DIFF_CAP) +
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
  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
  });
  const parsed = tryParseJSON(raw, {
    verdict: "changes_requested",
    summary: "",
    criteria: [],
    comments: [],
    suggestions: [],
  });
  return {
    summary: parsed.summary || "",
    criteria: parsed.criteria || [],
    comments: parsed.comments || [],
    suggestions: (parsed.suggestions || []).map((s: any) => ({
      criterionId: String(s.criterionId || ""),
      title: String(s.title || ""),
      rationale: String(s.rationale || ""),
      codeExample: s.codeExample ? String(s.codeExample) : undefined,
      fixPrompt: s.fixPrompt ? String(s.fixPrompt) : undefined,
    })),
  };
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
  const holisticItemCount =
    holistic.regressions.length + holistic.criticalErrors.length + holistic.securityFindings.length;
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
    lines.push("## End goal", endGoal, "");
  }

  // Lead with what needs attention. `splitForComment` (using the previous run's
  // verdicts) separates criteria a later commit broke (regressed) from still-open
  // ones (unmet) and the satisfied ones (met). Regressions and unmet are surfaced
  // prominently; met criteria are NOT re-listed inline on every run — they
  // collapse into a count header + a <details> block — so a re-review that only
  // added new criteria doesn't read as "all of them failed" when most already passed.
  const { regressed, unmet, met } = splitForComment(filledCriteria, prior);
  if (regressed.length) {
    lines.push("## Previously met — now broken");
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
  if (unmet.length) {
    lines.push("## Acceptance criteria not met");
    lines.push(
      "These requirements aren't satisfied by the current diff yet — each shows what was required and why it isn't met.",
      ""
    );
    for (const c of unmet) {
      lines.push(`- **${c.id} — Not met**`);
      lines.push(`  - Required: ${c.text}`);
      lines.push(`  - Why it's not met: ${reasonOrFallback(c.evidence)}`);
    }
    lines.push("");
  }
  if (met.length) {
    const header =
      unmet.length === 0 && regressed.length === 0
        ? `## All ${met.length} acceptance criteria met`
        : `## ${met.length} of ${filledCriteria.length} acceptance criteria met`;
    // Collapsed by default: the developer already saw these pass, so they're here
    // for reference, not re-litigation. The blank line after </summary> is what
    // lets GitHub render the list inside the <details>.
    lines.push(header, "", "<details><summary>Show met criteria</summary>", "");
    for (const c of met) {
      lines.push(`- **${c.id}** — ${c.text}`);
    }
    lines.push("", "</details>", "");
  }

  // Self-admitted deferred / incomplete work the diff's own comments concede.
  // Advisory (never blocks the merge) but surfaced prominently right under the
  // criteria — this is the "the agent quietly punted part of the design" signal
  // the author needs to see before merging. Rendered for both spec'd and
  // spec-less PRs; each item carries its own copyable fix prompt.
  if (holistic.deferrals.length) {
    lines.push("## Deferred / incomplete work");
    lines.push(
      "The diff's own comments concede that parts were deferred, stubbed, or only partially implemented. " +
        "These don't block the merge — confirm each was intentional, or use the prompt to finish it:",
      ""
    );
    appendHolisticGroup(lines, "Deferred", holistic.deferrals);
    lines.push("");
  }

  if (suggestions.length) {
    lines.push("## Suggested changes");
    for (const s of suggestions) {
      const heading = s.criterionId
        ? `### For ${s.criterionId} — ${s.title}`
        : `### ${s.title}`;
      lines.push(heading);
      if (s.rationale) lines.push(s.rationale);
      if (s.codeExample) {
        const fence = codeFence(s.codeExample);
        lines.push("", fence, s.codeExample, fence);
      }
      appendFixPrompt(lines, s.fixPrompt);
      lines.push("");
    }
  }

  // Line-anchored annotations from the review step. With no formal-review body to
  // carry them as native inline comments, they live here so the whole verdict
  // stays in this single comment.
  if (lineNotes.length) {
    lines.push("## Line notes");
    for (const n of lineNotes) {
      lines.push(`- \`${n.path}:${n.line}\` — ${n.body}`);
    }
    lines.push("");
  }

  const holisticItems =
    holistic.regressions.length + holistic.criticalErrors.length + holistic.securityFindings.length;
  if (holisticItems) {
    lines.push("## Repo-wide concerns");
    if (holistic.summary) lines.push(holistic.summary, "");
    appendHolisticGroup(lines, "Regressions", holistic.regressions);
    appendHolisticGroup(lines, "Critical errors", holistic.criticalErrors);
    appendHolisticGroup(lines, "Security findings", holistic.securityFindings);
    lines.push("");
  }

  // DEVASIGN.md nits (advisory). Convention violations the diff newly introduced
  // and DEVASIGN.md statements the diff made outdated. Never block the merge —
  // surfaced as nitpicks, each with its own copyable fix prompt.
  const devasignItems = holistic.conventionFindings.length + holistic.docDriftFindings.length;
  if (devasignItems) {
    lines.push("## DEVASIGN.md");
    lines.push(
      "Checked against your repo's DEVASIGN.md conventions. These are nits — they don't block the merge:",
      ""
    );
    appendHolisticGroup(lines, "Convention nits", holistic.conventionFindings);
    appendHolisticGroup(lines, "Docs to update", holistic.docDriftFindings);
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
    | "securityFindings"
    | "consistencyFindings"
    | "deferrals"
    | "conventionFindings"
    | "docDriftFindings";
  label: string;
}> = [
  { key: "regressions", label: "Regression" },
  { key: "criticalErrors", label: "Critical error" },
  { key: "securityFindings", label: "Security" },
  { key: "consistencyFindings", label: "Consistency" },
  { key: "deferrals", label: "Deferred work" },
  { key: "conventionFindings", label: "Convention" },
  { key: "docDriftFindings", label: "Docs" },
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
      lines.push(`What's wrong now: ${reasonOrFallback(c.evidence)}`);
      lines.push("");
      lines.push("How to fix:");
      // Match suggestions to this criterion by NORMALIZED id (trim + lowercase),
      // mirroring the verdict→criterion merge in runReviewJob. The review LLM can
      // echo `criterionId` in a different case/whitespace than the criterion's id
      // ("C1" vs "c1"); a strict === would drop the patch and fall back to the
      // generic "no specific patch" line. Normalize at the comparison only — not
      // on the stored suggestion — so the "## Suggested changes" heading keeps the
      // LLM's original casing.
      const cid = String(c.id ?? "").trim().toLowerCase();
      const relevant = suggestions.filter(
        (s) => String(s.criterionId ?? "").trim().toLowerCase() === cid
      );
      if (relevant.length === 0) {
        lines.push("No specific patch was suggested for this criterion. Implement the change so the Required behavior above holds, using \"What's wrong now\" as the starting point, then verify the criterion passes.");
        lines.push("");
      } else {
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
            if (s.codeExample) {
              const fence = codeFence(s.codeExample);
              lines.push("");
              lines.push(fence);
              lines.push(s.codeExample);
              lines.push(fence);
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

function appendHolisticGroup(
  lines: string[],
  label: string,
  findings: HolisticFinding[]
) {
  if (!findings.length) return;
  lines.push(`### ${label}`);
  for (const f of findings) {
    const sev = f.severity === "blocker" ? "**Blocker**" : "Warn";
    const where = f.path ? `\`${f.path}\` — ` : "";
    lines.push(`- ${sev} — ${where}${f.concern}`);
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
};

async function synthesizeBugFix(args: {
  videoSummary: VideoSummary;
  prTitle: string;
  diffSlice: string;
}): Promise<BugFixSynthesis> {
  const { videoSummary, prTitle, diffSlice } = args;
  const system =
    "You are DevAsign's bug-fix synthesis step. The user attached a video showing a bug they want fixed in an " +
    "open PR. Emit ONLY JSON: {\"title\": string, \"broken\": string, \"expected\": string, \"fix\": string, \"code\"?: string}. " +
    "`title` is ≤ 80 chars and reads like a PR/commit subject. `broken` describes the observed (incorrect) behavior " +
    "from the video. `expected` describes the correct behavior the video implies. `fix` is 1–2 sentences of " +
    "remediation. `code` is an optional minimal code example anchored in the PR diff — never invent a full file. " +
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
    const fence = codeFence(bug.code);
    lines.push(fence, bug.code, fence, "");
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
}> {
  const { review, endGoal, criteria, feedback } = args;
  const system =
    "You are DevAsign's maintainer-feedback goal refinement step. A maintainer or collaborator left a comment " +
    "on an open PR. Decide whether the comment (plus any video summaries or doc references it carries) adds " +
    "any NEW acceptance criteria — concrete, independently checkable requirements that aren't already covered " +
    "by the existing list. Never invent requirements the feedback didn't actually state. " +
    "Existing acceptance criteria are LOCKED: you must not remove, rephrase, renumber, merge, or restate them. " +
    "Your job is purely additive — only return brand-new criteria the comment introduces. If the comment is " +
    "conversational, off-topic, asks a question, or only restates something already in the list, return " +
    "`addedCriteria: []` and `changed: false`. " +
    "If there are NO existing acceptance criteria (the criteria list below is empty — the PR had no linked spec) and " +
    "the comment supplies goal or acceptance information, treat the comment as the authoritative specification and " +
    "populate `addedCriteria` directly from it (its text plus any video summaries or referenced docs provided). " +
    "You may refine `endGoal` to reflect the new direction, but only when `addedCriteria` is non-empty — otherwise " +
    "echo the original endGoal back unchanged. " +
    'Emit ONLY JSON: {"changed": boolean, "endGoal": string, "addedCriteria": [{"text": string}], "rationale": string}. ' +
    "Each `addedCriteria.text` is one independently checkable statement. Do NOT include ids — the system assigns them.";

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
    `## Existing criteria\n${criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n") || "(none)"}\n\n` +
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
    rationale?: string;
  }>(raw, { changed: false, endGoal, addedCriteria: [], rationale: "" });

  const addedTexts = (parsed.addedCriteria || [])
    .map((c) => String(c?.text || "").trim())
    .filter(Boolean);
  const rationale = String(parsed.rationale || "");

  // The merge is what enforces the additive contract: existing criteria pass
  // through bit-for-bit (so met/evidence from prior reviews survive) and the
  // new ones get appended with fresh non-colliding ids. `changed` is derived
  // from whether any additions actually landed — that way the contract stays
  // self-consistent even when the model contradicts itself.
  if (!addedTexts.length) {
    return { endGoal, criteria, added: [], changed: false, rationale };
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
  };
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
    "{\"title\": string, \"ask\": string, \"approach\": string, \"code\"?: string, \"references\": string[]}. " +
    "`title` ≤ 80 chars, commit-subject style. `ask` paraphrases what the maintainer wants in 1–2 sentences. " +
    "`approach` is 1–3 short paragraphs explaining how to implement it, anchored in the current diff where " +
    "possible. `code` is an optional minimal patch snippet — never a full file. `references` echoes any doc " +
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
    const fence = codeFence(guide.code);
    lines.push("## Reference snippet", fence, guide.code, fence, "");
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
  ctx: { prTitle: string; repoFullName: string; newCriteria: Criterion[] }
): string {
  const lines: string[] = [
    `### How to implement ${comment.author}'s feedback — ${guide.title}`,
    "",
    // The changes-requested notice lives here rather than in a formal review:
    // a REQUEST_CHANGES review requires a body, which GitHub renders as an
    // extra comment block — this guide is the one comment the feedback gets.
    "**Changes requested** — this feedback added new acceptance criteria, so the PR's " +
      "status is changes-requested until they are addressed. The review re-runs " +
      "automatically when you push a new commit.",
    "",
  ];
  if (guide.ask) lines.push("**What they asked**", guide.ask, "");
  if (guide.approach) lines.push("**Suggested approach**", guide.approach, "");
  if (guide.code) {
    const fence = codeFence(guide.code);
    lines.push(fence, guide.code, fence, "");
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

  if (refined.changed) {
    if (task) {
      db.update("tasks", (t) => t.id === task.id, { endGoal: refined.endGoal });
    }
    // The bar moved: new criteria came in from the maintainer's comment.
    // Flip the visible status to `changes_requested` so a PR that read as
    // "passed" no longer reads as approved while the developer hasn't had a
    // chance to implement the new requirement yet. We deliberately do NOT
    // re-run the full review here: the diff is unchanged, so re-checking it
    // against a criterion we just learned it can't meet only burns an LLM pass
    // and posts redundant findings. The implementation guide below is the
    // actionable feedback, and the lightweight REQUEST_CHANGES further down
    // blocks the merge. The real re-review fires on the next `synchronize`
    // webhook, once the developer actually pushes a commit.
    setStatus(review.id, {
      criteria: refined.criteria,
      status: "changes_requested",
    });
    log(review.id, "criteria", "End goal updated from maintainer feedback", {
      detail: refined.rationale || refined.endGoal,
      meta: { count: refined.criteria.length, added: refined.added.length, statusGated: true },
    });
  } else {
    log(review.id, "criteria", "Maintainer feedback reviewed; end goal unchanged", {
      detail: refined.rationale || "No actionable change inferred from the comment.",
    });
    // No goal movement → no PR reply. The "Maintainer feedback received" +
    // this "reviewed; unchanged" pair in the review log is the agent's
    // observable acknowledgement that it saw and considered the comment.
    return;
  }

  // Pull the latest diff so the implementation guide can be anchored in the
  // actual code. Best-effort: a missing install or a fetch failure just means
  // we synthesise the guide from feedback + criteria alone.
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

  const guide = await synthesizeImplementationGuide({
    feedback: {
      author: comment.author,
      body: comment.body,
      videoSummaries,
      docUrls,
    },
    endGoal: refined.endGoal,
    criteria: refined.criteria,
    prTitle: review.prTitle,
    diffSlice,
  });

  if (!install) return; // dev: nothing to post to

  const body = formatImplementationGuide(guide, comment, {
    prTitle: review.prTitle,
    repoFullName: `${repo.owner}/${repo.name}`,
    newCriteria: refined.added,
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

  // Block merge without re-running the pipeline: refresh the Check Run to
  // action_required and (in blocking mode) dismiss our stale approval. No new
  // conversation comment beyond the implementation guide above — the
  // changes-requested note is folded into the guide itself
  // (formatImplementationGuide). Advisory mode (verdict.blocking=false)
  // downgrades the event to COMMENT so the merge is never blocked — the policy
  // lives in resolveReviewEvent (decisions.ts).
  const wf = effectiveWorkflow(repo);
  const { event: reviewEvent } = resolveReviewEvent({
    status: "changes_requested",
    specless: refined.criteria.length === 0,
    blocking: wf.verdict.blocking,
    endGoalAlreadyRequested: !!task?.endGoalRequestedAt,
  });
  await postChangesRequestedNotice(review, repo, install, {
    event: reviewEvent,
    summary: "Maintainer feedback added new acceptance criteria; see the implementation guide.",
  });
  log(review.id, "verdict", "Changes requested — merge blocked; awaiting developer commit", {
    meta: { event: reviewEvent, reReview: false },
  });
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
  // The model often wraps JSON in ```json ... ```; extract first {...} block.
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return fallback;
  }
}

// ─── Whole-repo (holistic) review ─────────────────────────────────────────
// Uses the per-file repo index to answer: does this diff break anything, miss
// a critical edge, or introduce a security flaw? Runs in addition to the
// acceptance-criteria check; a blocker-severity finding flips status to
// changes_requested even when every criterion is otherwise met.

type HolisticFinding = {
  path?: string;
  concern: string;
  // "nit" sits below "warn": purely advisory DEVASIGN.md findings that never
  // gate the merge and render as nitpicks. Only "blocker" gates (see the status
  // gate in runReviewJob).
  severity: "blocker" | "warn" | "nit";
  // Self-contained prompt the user can paste into an external AI coding agent
  // to land the fix. Includes the relevant diff hunk inline.
  fixPrompt?: string;
};

type HolisticVerdict = {
  regressions: HolisticFinding[];
  criticalErrors: HolisticFinding[];
  securityFindings: HolisticFinding[];
  // Populated only by the spec-less pass (reviewSpeclessPR): concrete
  // deviations from how the rest of the codebase / recent merged PRs are
  // written. Advisory — never blocks a merge. Empty for spec'd reviews.
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
  summary: string;
};

export const EMPTY_HOLISTIC: HolisticVerdict = {
  regressions: [],
  criticalErrors: [],
  securityFindings: [],
  consistencyFindings: [],
  deferrals: [],
  conventionFindings: [],
  docDriftFindings: [],
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

  const system = withMaintainerInstructions(
    "You are DevAsign's holistic repo-review step. Given (1) a PR diff, (2) summaries of the files the PR touches, " +
    "(3) summaries of files that depend on the touched files, and (4) a manifest of the rest of the repo, decide " +
    "whether the PR introduces regressions, critical errors, or security flaws beyond what the acceptance criteria covered. " +
    'Emit ONLY JSON: {"regressions": [{"path": string, "concern": string, "severity": "blocker"|"warn", "fixPrompt": string}], ' +
    '"criticalErrors": [{"path": string?, "concern": string, "severity": "blocker"|"warn", "fixPrompt": string}], ' +
    '"securityFindings": [{"path": string?, "concern": string, "severity": "blocker"|"warn", "fixPrompt": string}], ' +
    '"summary": string}. ' +
    'Use severity="blocker" only when an issue would clearly break a feature, corrupt state, or expose data. ' +
    'Use severity="warn" for plausible concerns that need human eyes. ' +
    "Never invent risks the diff doesn't actually create. Quote symbol names or paths from the provided summaries when you cite a concern. " +
    "When nothing material surfaces, return empty arrays — do not pad. " +
    "This applies to `warn` findings as much as `blocker` findings: a `warn` is still a claim that must point to something concrete in the diff. Prefer empty arrays over speculative concerns. " +
    // Every finding must carry a copy-pasteable fixPrompt for the user's
    // external AI coding agent. Use this exact template (preserve newlines
    // and the inner ```diff fence):
    "Each finding MUST include a `fixPrompt` string the user can paste into another AI coding agent (Cursor / Claude Code / Codex). " +
    "Use this exact template:\n" +
    "Fix: <one-line summary>\n\n" +
    "File: <path or 'n/a'>\n" +
    "Symbol: <function/class/component name, or 'n/a'>\n\n" +
    "Issue:\n<2-3 sentence concern description>\n\n" +
    "Expected behavior:\n<1-2 sentences: what should happen once fixed>\n\n" +
    "Suggested approach:\n<concrete steps to fix>\n\n" +
    "Relevant diff:\n```diff\n<the exact hunk this finding refers to, copied verbatim from the PR diff in the user message>\n```\n" +
    "Quote the hunk verbatim — never invent code that isn't in the diff. Omit the 'Relevant diff' section only when the finding genuinely doesn't map to a hunk in the PR diff.", args.extraInstructions);

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

  const userText =
    `# Diff\n\`\`\`diff\n${args.diff.slice(0, 40_000)}\n\`\`\`\n\n` +
    `# Touched files (repo index summaries)\n${touchedBlock || "(none indexed)"}\n\n` +
    `# Dependent files\n${dependentsBlock || "(none)"}\n\n` +
    `# Repo manifest (top-level tour)\n${manifestBlock || "(none)"}`;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 1500,
  });
  const parsed = tryParseJSON<Partial<HolisticVerdict>>(raw, EMPTY_HOLISTIC);
  return {
    ...EMPTY_HOLISTIC,
    regressions: normaliseFindings(parsed.regressions),
    criticalErrors: normaliseFindings(parsed.criticalErrors),
    securityFindings: normaliseFindings(parsed.securityFindings),
    summary: String(parsed.summary || ""),
  };
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

  const system = withMaintainerInstructions(
    "You are DevAsign's DEVASIGN.md guidance step. A DEVASIGN.md states a team's own conventions. " +
    "Each DEVASIGN.md governs ONLY files under its own directory; the repo-root one governs every file, and rules " +
    "compound down the tree (a file obeys every DEVASIGN.md on its path, root → leaf). " +
    "You are given the PR diff and, per governing DEVASIGN.md, its directory scope, the changed files it governs, and its text. " +
    "Produce two advisory outputs, each strictly scoped to the governed files:\n" +
    "1. `violations`: conventions a governing DEVASIGN.md states that the diff NEWLY breaks. Only flag violations the diff " +
    "itself introduces — never pre-existing code, and never a file outside that doc's directory.\n" +
    "2. `docUpdates`: statements in a DEVASIGN.md that this diff makes outdated or incorrect, so the doc needs updating " +
    "(e.g. the diff replaces the approach the doc describes).\n" +
    'Emit ONLY JSON: {"violations": [{"path": string, "concern": string, "fixPrompt": string}], ' +
    '"docUpdates": [{"path": string, "concern": string, "fixPrompt": string}], "summary": string}. ' +
    "For a violation, `path` is the offending changed file and `concern` quotes the specific rule and how the diff breaks it. " +
    "For a docUpdate, `path` is the DEVASIGN.md file and `concern` quotes the now-outdated statement and what changed. " +
    "These are nitpicks, never blockers: do not flag subjective style, and never invent a rule the DEVASIGN.md doesn't state. " +
    "Prefer empty arrays over padding. " +
    "Each item MUST include a `fixPrompt` the user can paste into another AI coding agent (Cursor / Claude Code / Codex). " +
    "Use this exact template:\n" +
    "Fix: <one-line summary>\n\n" +
    "File: <path or 'n/a'>\n" +
    "Symbol: <function/class/component name, or 'n/a'>\n\n" +
    "Issue:\n<2-3 sentence description: the rule or statement, and the conflict the diff creates>\n\n" +
    "Expected behavior:\n<1-2 sentences: what should happen once fixed or updated>\n\n" +
    "Suggested approach:\n<concrete steps to fix the code, or to update the DEVASIGN.md>\n\n" +
    "Relevant diff:\n```diff\n<the exact hunk this refers to, copied verbatim from the PR diff>\n```\n" +
    "Quote the hunk verbatim — never invent code. Omit the 'Relevant diff' section only when the item doesn't map to a hunk.", args.extraInstructions);

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

  const userText =
    `# Diff\n\`\`\`diff\n${args.diff.slice(0, 40_000)}\n\`\`\`\n\n` +
    `# DEVASIGN.md files governing this PR's changed files\n${docsBlock}`;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 1500,
  });
  const parsed = tryParseJSON<{ violations?: unknown; docUpdates?: unknown; summary?: unknown }>(raw, {});
  // Force "nit" regardless of model output — DEVASIGN.md findings are uniformly
  // advisory (mirrors how reviewSpeclessPR forces consistency findings to warn).
  const toNit = (f: HolisticFinding): HolisticFinding => ({ ...f, severity: "nit" });
  return {
    conventionFindings: normaliseFindings(parsed.violations).map(toNit),
    docDriftFindings: normaliseFindings(parsed.docUpdates).map(toNit),
    summary: String(parsed.summary || ""),
  };
}

function normaliseFindings(input: unknown): HolisticFinding[] {
  if (!Array.isArray(input)) return [];
  const out: HolisticFinding[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const concern = String((item as any).concern || "").trim();
    if (!concern) continue;
    const sev = (item as any).severity === "blocker" ? "blocker" : "warn";
    const path = (item as any).path;
    const fixPrompt = (item as any).fixPrompt;
    out.push({
      concern,
      severity: sev,
      ...(typeof path === "string" && path ? { path } : {}),
      ...(typeof fixPrompt === "string" && fixPrompt ? { fixPrompt } : {}),
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
// mirroring how reviewSpeclessPR treats consistencyFindings). Exported for
// testing alongside scanDeferralCandidates.
export async function detectDeferredWork(args: {
  diff: string;
  promise: string;
  candidates: DeferralCandidate[];
  extraInstructions?: string;
}): Promise<HolisticFinding[]> {
  const { diff, promise, candidates } = args;
  if (!candidates.length) return [];

  const system = withMaintainerInstructions(
    "You are DevAsign's deferred-work detection step. A coding agent often agrees to a design, then during " +
    "implementation quietly punts part of it — leaving the admission in a code comment (a TODO, a stub, " +
    '"for now", "deferred to a follow-up", NotImplemented) instead of telling the author. Your job is to catch ' +
    "those self-admissions in the PR's OWN added lines and surface them.\n" +
    "You are given: (1) what the PR promised (end goal, acceptance criteria, and PR/issue description); (2) the " +
    "diff; (3) candidate marker lines the pre-scan flagged in the added code. For each candidate, decide whether " +
    "it genuinely concedes that something was deferred, stubbed, only partially implemented, or left unhandled. " +
    "Keep only the real ones — drop benign matches (an unrelated pre-existing TODO, a marker inside a logging " +
    'string or test fixture, a word like "pending" used in normal prose). Never invent a deferral the diff does ' +
    "not actually state.\n" +
    "In each finding's `concern`, START with either `Contradicts <the criterion id / 'end goal' / 'PR " +
    "description'>` when the punt undercuts something the PR promised, or `Incidental` when it does not — then a " +
    "colon, a short explanation, and the offending comment quoted verbatim.\n" +
    'Emit ONLY JSON: {"deferrals": [{"path": string?, "concern": string, "fixPrompt": string}], "summary": string}. ' +
    "Return an empty array when none of the candidates is a real, material deferral — prefer empty over padding. " +
    "Each finding MUST include a `fixPrompt` the user can paste into another AI coding agent (Cursor / Claude Code / Codex). " +
    "Use this exact template:\n" +
    "Fix: <one-line summary>\n\n" +
    "File: <path or 'n/a'>\n" +
    "Symbol: <function/class/component name, or 'n/a'>\n\n" +
    "Issue:\n<2-3 sentences: what was deferred and what it undercuts>\n\n" +
    "Expected behavior:\n<1-2 sentences: what should happen once the deferred part is implemented>\n\n" +
    "Suggested approach:\n<concrete steps to actually implement the deferred part>\n\n" +
    "Relevant diff:\n```diff\n<the exact hunk this finding refers to, copied verbatim from the PR diff>\n```\n" +
    "Quote the hunk verbatim — never invent code. Omit the 'Relevant diff' section only when the finding doesn't map to a hunk.", args.extraInstructions);

  const candidateBlock = candidates
    .map((c, i) => `${i + 1}. ${c.path || "(unknown file)"} — \`${c.lineText}\``)
    .join("\n");

  const userText =
    `# What this PR promised\n${promise || "(no explicit promise on record — compare against the PR's apparent intent)"}\n\n` +
    `# Candidate self-admissions found in the added code\n${candidateBlock}\n\n` +
    `# Diff\n\`\`\`diff\n${diff.slice(0, 40_000)}\n\`\`\``;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 1500,
  });
  const parsed = tryParseJSON<{ deferrals?: unknown }>(raw, { deferrals: [] });
  // Advisory: force "warn" so a deferral never flips the merge status. The
  // model's contradiction judgment is preserved in the `concern` prefix.
  return normaliseFindings(parsed.deferrals).map((f) => ({ ...f, severity: "warn" as const }));
}

// --- Spec-less review (security + consistency) ---
//
// When a PR has no linked issue / spec / attachment there are no acceptance
// criteria to check. Rather than inventing some or rubber-stamping the PR, we
// do two concrete things the diff alone supports: (1) a focused security
// review, and (2) a consistency check against how the rest of the team's code
// is written. The conventions baseline prefers the repo index; when the index
// isn't built yet it falls back to a sample of recent merged PRs.

type MergedPRSample = { number: number; title: string; diff: string };

// Pull the diffs of the most recent merged PRs as a convention baseline.
// Best-effort: returns [] when there's no install or GitHub is unreachable.
async function listRecentMergedPRDiffs(
  install: { installationId: number } | null,
  repo: { owner: string; name: string },
  opts: { count?: number; excludePr?: number; maxBytes?: number } = {}
): Promise<MergedPRSample[]> {
  if (!install) return [];
  const count = opts.count ?? 5;
  const maxBytes = opts.maxBytes ?? 6000;
  let list: any[] = [];
  try {
    list = await gh<any[]>(
      install.installationId,
      `/repos/${repo.owner}/${repo.name}/pulls?state=closed&sort=updated&direction=desc&per_page=20`
    );
  } catch (err) {
    console.warn("[specless] listing merged PRs failed:", err);
    return [];
  }
  const merged = list
    .filter((p) => p && p.merged_at && p.number !== opts.excludePr)
    .slice(0, count);
  // Fetch each merged PR's diff in parallel — they're independent network
  // round-trips and we'd otherwise pay 5× the latency for what is the longest
  // step on the spec-less path.
  const results = await Promise.all(
    merged.map(async (pr): Promise<MergedPRSample | null> => {
      try {
        const diff = await ghText(
          install.installationId,
          `/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
          { Accept: "application/vnd.github.v3.diff" }
        );
        return { number: pr.number, title: String(pr.title || ""), diff: diff.slice(0, maxBytes) };
      } catch (err) {
        console.warn(`[specless] diff for merged PR #${pr.number} failed:`, err);
        return null;
      }
    })
  );
  return results.filter((r): r is MergedPRSample => r !== null);
}

async function reviewSpeclessPR(args: {
  review: PRReview;
  diff: string;
  holistic: HolisticContext;
  priorPRs: MergedPRSample[];
}): Promise<HolisticVerdict> {
  const { holistic, priorPRs } = args;

  // Convention baseline: index summaries when available, else merged-PR diffs.
  const usingIndex = holistic.entries.length > 0 || holistic.manifest.length > 0;
  const conventionsBlock = usingIndex
    ? [
        ...holistic.entries.map(
          (e) =>
            `### ${e.path}\n` +
            `Exports: ${e.exports.join(", ") || "(none)"}\n` +
            `Imports: ${e.imports.join(", ") || "(none)"}\n` +
            `Flags: ${e.securityFlags.join(", ") || "(none)"}\n` +
            `Summary: ${e.summary}`
        ),
        ...holistic.manifest.map((m) => `- ${m.path}: ${m.summary}`),
      ].join("\n\n")
    : priorPRs
        .map((p) => `## Merged PR #${p.number} — ${p.title}\n\`\`\`diff\n${p.diff}\n\`\`\``)
        .join("\n\n");
  const conventionsLabel = usingIndex
    ? "how the merged-in codebase is written (repo index summaries)"
    : "how recent merged PRs in this repo are written (their diffs)";

  const system =
    "You are DevAsign's spec-less PR review step. This PR has NO linked issue, spec, or attachment, so there are no " +
    "acceptance criteria. Do two concrete jobs instead, grounded ONLY in the diff:\n" +
    "1. SECURITY: find real vulnerabilities the diff introduces — injection (SQL/command/template), missing authz/authn, " +
    "secrets or credentials committed, unsafe deserialization, SSRF, path traversal, XSS, weak crypto, unvalidated input " +
    "reaching a sink. Only flag issues the diff actually creates; never speculate.\n" +
    "2. CONSISTENCY: compare the PR against the provided examples of " + conventionsLabel + ". Flag concrete deviations " +
    "(naming, error handling, logging, module/import structure, test patterns, API shape) where this PR diverges from the " +
    "established convention. Cite the specific convention you're comparing against. Never invent a rule the examples don't " +
    "demonstrate, and never flag subjective style.\n" +
    "Also report any regressions or critical errors the diff plainly introduces.\n" +
    'Emit ONLY JSON: {"securityFindings": [Finding], "consistencyFindings": [Finding], "regressions": [Finding], ' +
    '"criticalErrors": [Finding], "summary": string}. ' +
    'A Finding is {"path": string?, "concern": string, "severity": "blocker"|"warn", "fixPrompt": string}. ' +
    'severity="blocker" only when an issue would expose data, break a feature, or corrupt state; otherwise "warn". ' +
    "Consistency findings are advisory — always severity=\"warn\". " +
    "Return empty arrays when nothing material surfaces — prefer empty over padding. " +
    "Each finding MUST include a `fixPrompt` the user can paste into another AI coding agent. Use this exact template:\n" +
    "Fix: <one-line summary>\n\n" +
    "File: <path or 'n/a'>\n" +
    "Symbol: <function/class/component name, or 'n/a'>\n\n" +
    "Issue:\n<2-3 sentence concern description>\n\n" +
    "Expected behavior:\n<1-2 sentences: what should happen once fixed>\n\n" +
    "Suggested approach:\n<concrete steps to fix>\n\n" +
    "Relevant diff:\n```diff\n<the exact hunk this finding refers to, copied verbatim from the PR diff>\n```\n" +
    "Quote the hunk verbatim — never invent code. Omit the 'Relevant diff' section only when the finding doesn't map to a hunk.";

  const userText =
    `# PR ${args.review.prTitle}\n\n` +
    `# Diff under review\n\`\`\`diff\n${args.diff.slice(0, 40_000)}\n\`\`\`\n\n` +
    `# Conventions baseline — ${conventionsLabel}\n${conventionsBlock || "(none available)"}`;

  const raw = await complete({
    system,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 1800,
  });
  const parsed = tryParseJSON<Partial<HolisticVerdict>>(raw, EMPTY_HOLISTIC);
  // Force consistency findings to advisory severity regardless of model output.
  const consistencyFindings = normaliseFindings(parsed.consistencyFindings).map((f) => ({
    ...f,
    severity: "warn" as const,
  }));
  // Spread EMPTY_HOLISTIC so fields this pass doesn't populate (e.g. deferrals,
  // which are produced by the separate detectDeferredWork pass) get their
  // canonical default automatically.
  return {
    ...EMPTY_HOLISTIC,
    regressions: normaliseFindings(parsed.regressions),
    criticalErrors: normaliseFindings(parsed.criticalErrors),
    securityFindings: normaliseFindings(parsed.securityFindings),
    consistencyFindings,
    summary: String(parsed.summary || ""),
  };
}
