// Review pipeline. Spec: devasign.md §5.
//   a. Context ingestion (GitHub diff + Linear/Slack/Figma/Loom/PDF attachments)
//   b. Criteria synthesis ("End goal")
//   c. Review (multimodal LLM compares diff vs each criterion)
//   d. Output (post Check Run + PR review; write reviewLogs; broadcast)
//   e. Eval (LLM-as-judge; out-of-band, not in this hot path)
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { gh } from "../github/app.js";
import { complete, detectVideoProvider, summarizeVideo, type VideoSummary } from "../llm.js";
import { broadcastVerdict } from "../integrations/broadcast.js";
import { config } from "../config.js";
import { enqueueReview, type MaintainerComment } from "../queue.js";
import type { Criterion, PRReview, PRReviewStatus, RepoIndexEntry, Repository, ReviewLogEntry, ReviewLogKind, Task } from "../types.js";

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

// Per-finding log row. Keeps the timeline render uniform (TimelineFor branches
// on kind === "finding") and avoids extending the PRReview shape.
type FindingCategory = "regression" | "criticalError" | "security" | "suggestion";

function emitFindingLog(
  reviewId: string,
  category: Exclude<FindingCategory, "suggestion">,
  finding: { path?: string; concern: string; severity: "blocker" | "warn"; fixPrompt?: string }
) {
  const titleByCategory: Record<typeof category, string> = {
    regression: "Possible regression",
    criticalError: "Critical error",
    security: "Security finding",
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
  if (s.codeExample) bodyParts.push("```\n" + s.codeExample + "\n```");
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

  setStatus(review.id, { status: "reviewing" });
  log(review.id, "review", "Pipeline started");

  try {
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
    const holistic = gatherHolisticContext(repo, context.diff);
    if (holistic.entries.length || holistic.manifest.length) {
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
    let endGoal = task.endGoal;
    let criteria: Criterion[] = [];
    if (!endGoal || review.criteria.length === 0) {
      const synth = await synthesizeCriteria(review, context);
      endGoal = synth.endGoal;
      criteria = synth.criteria;
      db.update("tasks", (t) => t.id === task.id, { endGoal });
      log(review.id, "criteria", "End goal synthesized", {
        detail: endGoal,
        meta: { count: criteria.length },
      });
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
    }

    setStatus(review.id, { taskId: task.id, criteria });

    // c. Review the diff against the criteria
    const verdict = await reviewDiff(review, context, criteria);
    const filledCriteria: Criterion[] = criteria.map((c) => {
      const m = verdict.criteria.find((vc) => vc.id === c.id);
      return { ...c, met: m?.met ?? null, evidence: m?.evidence ?? null };
    });
    const allMet = filledCriteria.every((c) => c.met === true);

    // c.1 Whole-repo review: ask Opus to check the diff against the repo index
    // for regressions, critical errors, and security flaws. Skipped when the
    // index hasn't been built yet (e.g. a PR landed before the initial walk
    // finished); in that case we fall back to the criteria-only verdict.
    let holisticVerdict: HolisticVerdict = EMPTY_HOLISTIC;
    let hasBlocker = false;
    if (holistic.entries.length || holistic.manifest.length) {
      holisticVerdict = await reviewAgainstRepo({ review, diff: context.diff, holistic });
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

    const status: PRReviewStatus = allMet && !hasBlocker ? "passed" : "changes_requested";
    setStatus(review.id, {
      criteria: filledCriteria,
      verdict: verdict.summary,
      status,
    });
    log(review.id, "verdict", status === "passed" ? "All checks met" : "Changes requested", {
      detail: verdict.summary,
      meta: {
        criteriaCount: filledCriteria.length,
        holisticBlockers: hasBlocker,
        holisticFindings:
          holisticVerdict.regressions.length +
          holisticVerdict.criticalErrors.length +
          holisticVerdict.securityFindings.length,
      },
    });

    // d. Output: GitHub Check Run + PR review + broadcast
    await postGithubOutput(review, repo, install, status, {
      endGoal: endGoal || "",
      criteria: filledCriteria,
      summary: verdict.summary,
      suggestions: verdict.suggestions,
      comments: verdict.comments,
      diff: context.diff,
      holistic: holisticVerdict,
    });
    await broadcastVerdict(review, repo, status, verdict.summary);
    log(review.id, "comment", "Posted Check Run and PR review", {
      meta: {
        inlineComments: verdict.comments.length,
        suggestions: verdict.suggestions.length,
      },
    });
  } catch (err) {
    console.error(`[review] ${review.id} failed:`, err);
    setStatus(review.id, { status: "errored" });
    log(review.id, "error", "Pipeline errored", {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Context ingestion ---

type IngestedSource = { kind: string; ref: string; text: string };
type Context = {
  sources: IngestedSource[];
  diff: string;
  videos: VideoSummary[];
  primaryIssues: number[];
  secondaryIssues: number[];
};

async function ingestContext(
  review: PRReview,
  repo: { owner: string; name: string },
  install: { installationId: number } | null
): Promise<Context> {
  const sources: IngestedSource[] = [];
  let diff = "";
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
      sources.push({
        kind: "github_pr",
        ref: `${repo.owner}/${repo.name}#${review.prNumber}`,
        text: `${pr.title}\n\n${pr.body || ""}`,
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

  return { sources, diff, videos, primaryIssues, secondaryIssues };
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

async function synthesizeCriteria(review: PRReview, context: Context): Promise<{
  endGoal: string;
  criteria: Criterion[];
}> {
  const system =
    "You are DevAsign's criteria synthesis step. Read the ticket and surrounding context, then emit a JSON object: " +
    "{\"endGoal\": string, \"criteria\": [{\"id\": string, \"text\": string}]}. " +
    "The endGoal is one sentence summarising what success looks like. Each criterion is independently checkable. " +
    "Sources labelled `github_issue_primary` are the canonical job-to-be-done (the issue the PR closes/fixes); " +
    "treat their description as authoritative. `github_issue` rows are secondary background. " +
    "`video_summary` rows describe what a Loom/YouTube/Vimeo showed; use them when the issue/PR text was vague.";
  const userText =
    `# PR ${review.prTitle}\n\n## Context\n` +
    context.sources
      .filter((s) => s.kind !== "diff")
      .map((s) => `### ${s.kind} (${s.ref})\n${s.text}`)
      .join("\n\n");
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
  criteria: Criterion[]
): Promise<{
  summary: string;
  criteria: Array<{ id: string; met: boolean; evidence: string }>;
  comments: Array<{ path: string; line: number; body: string }>;
  suggestions: ReviewSuggestion[];
}> {
  const system =
    "You are DevAsign's PR review step. Evaluate the diff against each criterion. Emit JSON: " +
    "{\"verdict\": \"passed\"|\"changes_requested\", \"summary\": string, " +
    "\"criteria\": [{\"id\": string, \"met\": boolean, \"evidence\": string}], " +
    "\"comments\": [{\"path\": string, \"line\": number, \"body\": string}], " +
    "\"suggestions\": [{\"criterionId\": string, \"title\": string, \"rationale\": string, \"codeExample\"?: string, \"fixPrompt\": string}]}. " +
    "Be specific about evidence — quote the diff where possible. " +
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
    "Suggested approach:\n<concrete steps to fix>\n\n" +
    "Relevant diff:\n```diff\n<the exact hunk this finding refers to, copied verbatim from the PR diff in the user message>\n```\n" +
    "Quote the hunk verbatim — never invent code that isn't in the diff. Omit the 'Relevant diff' section only when the finding doesn't map to a specific hunk.";
  const userText =
    `# Criteria\n${criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n")}\n\n` +
    `# Diff\n\`\`\`diff\n${context.diff.slice(0, 40_000)}\n\`\`\`\n\n` +
    `# Supporting context\n` +
    context.sources
      .filter((s) => s.kind !== "diff")
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

// Build the markdown body that lands as the GitHub PR Review body. The shape
// is intentionally scannable: end goal, then a checked/unchecked criteria
// list with per-criterion evidence, then concrete suggestions the developer
// can apply in a follow-up commit.
function formatReviewBody(
  endGoal: string,
  filledCriteria: Criterion[],
  suggestions: ReviewSuggestion[],
  summary: string,
  holistic: HolisticVerdict = EMPTY_HOLISTIC,
  context?: { prTitle: string; repoFullName: string }
): string {
  const lines: string[] = [];
  if (endGoal) {
    lines.push("## End goal", endGoal, "");
  }

  // Split the criteria into two labeled sections instead of one mixed
  // task list. The single `[x]`/`[ ]` list reads as "status"; the split
  // makes failures the dominant signal at the top of the comment so the
  // developer sees what they have to fix at a glance.
  const unmet = filledCriteria.filter((c) => c.met !== true);
  const met = filledCriteria.filter((c) => c.met === true);
  if (unmet.length) {
    lines.push("## ❌ Acceptance criteria not met");
    for (const c of unmet) {
      lines.push(`- **${c.id}** — ${c.text}`);
      if (c.evidence) lines.push(`  _Why it failed:_ ${c.evidence}`);
    }
    lines.push("");
  }
  if (met.length) {
    const header = unmet.length === 0
      ? `## ✅ Acceptance criteria met (all ${met.length} met)`
      : `## ✅ Acceptance criteria met (${met.length} / ${filledCriteria.length})`;
    lines.push(header);
    for (const c of met) {
      lines.push(`- **${c.id}** — ${c.text}`);
    }
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
        lines.push("", "```", s.codeExample, "```");
      }
      appendFixPrompt(lines, s.fixPrompt);
      lines.push("");
    }
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
  if (summary) {
    lines.push("---", summary);
  }

  // Consolidated "fix everything in one paste" prompt for an external AI
  // coding agent (Claude Code, Cursor, Aider, Codex). Only included when
  // there's anything to fix — at least one unmet criterion or one
  // blocker-severity holistic finding. The per-suggestion fixPrompts above
  // stay too, for users who want to fix one item at a time.
  //
  // The outer fence uses 6 backticks so per-suggestion fixPrompts (which
  // themselves contain ```diff fences) don't accidentally close it. GitHub
  // renders 4+-backtick fences as code blocks with a copy button, so the
  // user gets one-click copy of the whole prompt.
  const blockerHolistic = [
    ...holistic.regressions,
    ...holistic.criticalErrors,
    ...holistic.securityFindings,
  ].filter((f) => f.severity === "blocker");
  if (context && (unmet.length > 0 || blockerHolistic.length > 0)) {
    const prompt = buildConsolidatedFixPrompt({
      prTitle: context.prTitle,
      repoFullName: context.repoFullName,
      endGoal,
      unmetCriteria: unmet,
      suggestions,
      blockerHolistic,
    });
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("<details>");
    lines.push("<summary>📋 One prompt to fix all of this — paste into your AI coding agent</summary>");
    lines.push("");
    lines.push("``````");
    lines.push(prompt);
    lines.push("``````");
    lines.push("");
    lines.push("</details>");
  }

  return lines.join("\n").trim() || "DevAsign review.";
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
  blockerHolistic: HolisticFinding[];
}): string {
  const { prTitle, repoFullName, endGoal, unmetCriteria, suggestions, blockerHolistic } = args;
  const lines: string[] = [];
  lines.push(`You are helping fix PR "${prTitle}" in ${repoFullName}. Automated review flagged the items below as blocking approval. Apply the changes so each one passes — don't introduce changes beyond what's listed.`);
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
      lines.push(`### ${i + 1}. ${c.text} (${c.id})`);
      if (c.evidence) {
        lines.push(`_Why it failed:_ ${c.evidence}`);
      }
      lines.push("");
      const relevant = suggestions.filter((s) => s.criterionId === c.id);
      if (relevant.length === 0) {
        lines.push("_(No specific patch was suggested for this criterion — use the criterion text and evidence above to plan the fix.)_");
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
              lines.push("");
              lines.push("```");
              lines.push(s.codeExample);
              lines.push("```");
            }
          }
          lines.push("");
        }
      }
    });
  }
  if (blockerHolistic.length) {
    lines.push("## Repo-wide blockers (must also be addressed)");
    lines.push("");
    blockerHolistic.forEach((f, i) => {
      const where = f.path ? `\`${f.path}\` — ` : "";
      lines.push(`### ${i + 1}. ${where}${f.concern}`);
      lines.push("");
      if (f.fixPrompt) {
        lines.push(f.fixPrompt);
      }
      lines.push("");
    });
  }
  lines.push("## Your task");
  lines.push("For each failed criterion and blocker above, apply the suggested fix. Use the `Relevant diff` hunks as the anchor for where to make the change. After each change, re-verify it satisfies the criterion or addresses the blocker it's tied to.");
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
    const sev = f.severity === "blocker" ? "🚫 **Blocker**" : "⚠️ Warn";
    const where = f.path ? `\`${f.path}\` — ` : "";
    lines.push(`- ${sev} — ${where}${f.concern}`);
    appendFixPrompt(lines, f.fixPrompt, /* indented */ true);
  }
  lines.push("");
}

// Renders the per-finding "prompt for your AI agent" block. The prompt sits in
// a top-level ``` fence so GitHub's built-in code-block copy button picks it
// up — no client-side wiring needed for the GitHub surface. The optional
// indent variant keeps list-rendered findings (holistic) readable.
function appendFixPrompt(lines: string[], fixPrompt: string | undefined, indented = false) {
  if (!fixPrompt) return;
  const pad = indented ? "  " : "";
  lines.push("");
  lines.push(`${pad}**Prompt for your AI agent:**`);
  lines.push("");
  lines.push(`${pad}\`\`\``);
  for (const ln of fixPrompt.split("\n")) lines.push(`${pad}${ln}`);
  lines.push(`${pad}\`\`\``);
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
  }
) {
  if (!install) return; // dev: nothing to post to
  const conclusion = status === "passed" ? "success" : "action_required";
  const body = formatReviewBody(
    args.endGoal,
    args.criteria,
    args.suggestions,
    args.summary,
    args.holistic,
    { prTitle: review.prTitle, repoFullName: `${repo.owner}/${repo.name}` }
  );

  try {
    await gh(install.installationId, `/repos/${repo.owner}/${repo.name}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: "DevAsign · End goal",
        head_sha: review.headSha,
        status: "completed",
        conclusion,
        output: {
          title: status === "passed" ? "All acceptance criteria met" : "Changes requested",
          summary: args.summary || "",
        },
      }),
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.warn("[review] failed to post check run:", err);
  }

  // Translate the LLM's inline annotations into GitHub's review-comment shape.
  // Pre-filter against the file paths actually present in the diff so a bad
  // `path` from the model doesn't poison the whole review (GitHub rejects the
  // entire batch on the first invalid comment).
  const validPaths = diffFilePaths(args.diff);
  const inline = (args.comments || [])
    .filter((c) => c.path && c.body && Number.isFinite(c.line) && validPaths.has(c.path))
    .map((c) => ({ path: c.path, line: c.line, side: "RIGHT" as const, body: c.body }));

  // PR review (single grouped comment so the conversation doesn't get spammy)
  try {
    await gh(install.installationId, `/repos/${repo.owner}/${repo.name}/pulls/${review.prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        event: status === "passed" ? "APPROVE" : "REQUEST_CHANGES",
        body,
        ...(inline.length ? { comments: inline } : {}),
      }),
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // The inline batch is the usual culprit when the review POST fails (bad
    // line numbers, deleted files, etc). Fall back to posting just the body
    // so the verdict still lands.
    console.warn("[review] failed to post PR review with inline:", err);
    if (inline.length) {
      try {
        await gh(install.installationId, `/repos/${repo.owner}/${repo.name}/pulls/${review.prNumber}/reviews`, {
          method: "POST",
          body: JSON.stringify({
            event: status === "passed" ? "APPROVE" : "REQUEST_CHANGES",
            body,
          }),
          headers: { "Content-Type": "application/json" },
        });
      } catch (err2) {
        console.warn("[review] verdict-only fallback also failed:", err2);
      }
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
    `### 🎥 Bug observed in attached video — ${bug.title}`,
    "",
  ];
  if (bug.broken) lines.push("**What's broken**", bug.broken, "");
  if (bug.expected) lines.push("**Expected**", bug.expected, "");
  if (bug.fix) lines.push("**Suggested fix**", bug.fix, "");
  if (bug.code) lines.push("```", bug.code, "```", "");
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
}): Promise<{ endGoal: string; criteria: Criterion[]; changed: boolean; rationale: string }> {
  const { review, endGoal, criteria, feedback } = args;
  const system =
    "You are DevAsign's maintainer-feedback goal refinement step. A maintainer or collaborator left a comment " +
    "on an open PR. Decide whether the comment (plus any video summaries or doc references it carries) " +
    "meaningfully changes what 'done' means for the PR. Only update the goal/criteria when the feedback adds " +
    "something concrete and clearly aligned with the product being built. Never invent requirements the " +
    "feedback didn't actually state. " +
    'Emit ONLY JSON: {"changed": boolean, "endGoal": string, "criteria": [{"id": string, "text": string}], "rationale": string}. ' +
    "When `changed` is false, echo back the original endGoal and criteria.";

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
    "URLs the maintainer cited. Never invent requirements the feedback didn't state.";

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

function formatImplementationGuide(
  guide: ImplementationGuide,
  comment: { author: string; sourceUrl: string }
): string {
  const lines: string[] = [
    `### 🛠️ How to implement ${comment.author}'s feedback — ${guide.title}`,
    "",
  ];
  if (guide.ask) lines.push("**What they asked**", guide.ask, "");
  if (guide.approach) lines.push("**Suggested approach**", guide.approach, "");
  if (guide.code) lines.push("```", guide.code, "```", "");
  if (guide.references.length) {
    lines.push("**References**");
    for (const r of guide.references) lines.push(`- ${r}`);
    lines.push("");
  }
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
      kind: "loom" as const,
      url: u,
      note: `from maintainer ${comment.author}`,
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
    endGoal: task?.endGoal || "",
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
    // "passed" no longer reads as approved while the developer hasn't had
    // a chance to implement the new requirement yet. Re-enqueue a full
    // review so the diff is re-checked against the updated criteria and a
    // fresh REQUEST_CHANGES review lands on the GitHub PR.
    setStatus(review.id, {
      criteria: refined.criteria,
      status: "changes_requested",
    });
    enqueueReview(review.id);
    log(review.id, "criteria", "End goal updated from maintainer feedback", {
      detail: refined.rationale || refined.endGoal,
      meta: { count: refined.criteria.length, statusGated: true },
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

  const body = formatImplementationGuide(guide, comment);
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
  severity: "blocker" | "warn";
  // Self-contained prompt the user can paste into an external AI coding agent
  // to land the fix. Includes the relevant diff hunk inline.
  fixPrompt?: string;
};

type HolisticVerdict = {
  regressions: HolisticFinding[];
  criticalErrors: HolisticFinding[];
  securityFindings: HolisticFinding[];
  summary: string;
};

const EMPTY_HOLISTIC: HolisticVerdict = {
  regressions: [],
  criticalErrors: [],
  securityFindings: [],
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
}): Promise<HolisticVerdict> {
  const { holistic } = args;
  if (!holistic.entries.length && !holistic.manifest.length) return EMPTY_HOLISTIC;

  const system =
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
    // Every finding must carry a copy-pasteable fixPrompt for the user's
    // external AI coding agent. Use this exact template (preserve newlines
    // and the inner ```diff fence):
    "Each finding MUST include a `fixPrompt` string the user can paste into another AI coding agent (Cursor / Claude Code / Codex). " +
    "Use this exact template:\n" +
    "Fix: <one-line summary>\n\n" +
    "File: <path or 'n/a'>\n" +
    "Symbol: <function/class/component name, or 'n/a'>\n\n" +
    "Issue:\n<2-3 sentence concern description>\n\n" +
    "Suggested approach:\n<concrete steps to fix>\n\n" +
    "Relevant diff:\n```diff\n<the exact hunk this finding refers to, copied verbatim from the PR diff in the user message>\n```\n" +
    "Quote the hunk verbatim — never invent code that isn't in the diff. Omit the 'Relevant diff' section only when the finding genuinely doesn't map to a hunk in the PR diff.";

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
    regressions: normaliseFindings(parsed.regressions),
    criticalErrors: normaliseFindings(parsed.criticalErrors),
    securityFindings: normaliseFindings(parsed.securityFindings),
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
