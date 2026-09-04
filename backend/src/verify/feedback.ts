// PR-comment feedback loop for verification. A maintainer's comment is
// classified into actions; changes land as a NEW criteria revision (the
// original is never mutated), only the affected criteria are re-planned in a
// new run that inherits the rest, the runner is re-triggered via
// repository_dispatch, and a reply under the comment says what changed.
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { completeWithMeta, withModel, withUsage } from "../llm.js";
import { modelForPlan } from "../billing/plans.js";
import { extractJSON } from "../review/parse.js";
import { verificationFeedbackSystemPrompt } from "../review/prompts.js";
import { effectiveWorkflow } from "../review/workflow.js";
import { postPRCommentReturningId, repositoryDispatch } from "../github/app.js";
import { enqueueVerifyFeedback, type MaintainerComment } from "../queue.js";
import type { Criterion, Installation, PRCommentAction, PRCommentActionKind, Repository, VerifyRun } from "../types.js";
import { runVerifyPlan } from "./plan.js";
import { rerenderReport, runDeepLink } from "./report.js";
import { createVerifyRun, latestRunForReview, snapshotCriteriaRevision, updateRun } from "./runs.js";

export const CONFIDENCE_THRESHOLD = 0.6;
export const DISPATCH_EVENT = "devasign-verify";
const IN_FLIGHT = new Set<VerifyRun["status"]>(["planning", "awaiting_runner", "running", "judging"]);
const ACTIONS: ReadonlySet<string> = new Set<PRCommentActionKind>(["add_criterion", "remove_criterion", "reword_criterion", "mark_not_applicable", "rerun", "question", "ignore"]);

export type ClassifiedAction = PRCommentAction["classified"][number];

export type FeedbackDeps = {
  llm?: (args: { system: string; user: string }) => Promise<string>;
  postReply?: (install: Installation, repo: Repository, prNumber: number, body: string) => Promise<number | null>;
  dispatch?: (install: Installation, repo: Repository, payload: Record<string, unknown>) => Promise<void>;
  plan?: (runId: string, onlyCriteriaIds: string[]) => Promise<unknown>;
};

export function isBotLogin(login: string, appName = config.github.appName): boolean {
  const l = (login || "").toLowerCase();
  return l.endsWith("[bot]") || l === `${appName.toLowerCase()}[bot]` || l === appName.toLowerCase();
}

function isVerifiable(c: Criterion): boolean {
  return (c.kind ?? "code") !== "unverifiable" && !c.notApplicable && !c.supersededBy;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ");
}

export function normalizeActions(raw: unknown): { actions: ClassifiedAction[]; reply: string | null } {
  const o = (raw || {}) as { actions?: unknown; reply?: unknown };
  const actions: ClassifiedAction[] = [];
  for (const a of Array.isArray(o.actions) ? o.actions : []) {
    const x = (a || {}) as Record<string, unknown>;
    if (!ACTIONS.has(String(x.action))) continue;
    const confidence = Number(x.confidence);
    actions.push({
      action: x.action as PRCommentActionKind,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      actedOnText: String(x.actedOnText ?? "").slice(0, 500),
      ...(typeof x.criterionId === "string" && x.criterionId ? { criterionId: x.criterionId } : {}),
      ...(typeof x.text === "string" && x.text.trim() ? { text: x.text.trim().slice(0, 400) } : {}),
    });
  }
  return { actions, reply: typeof o.reply === "string" && o.reply.trim() ? o.reply.trim().slice(0, 2000) : null };
}

export type Applied = { criteria: Criterion[]; affectedIds: string[]; rerunAll: boolean; summary: string[] };

/** Apply high-confidence change actions to a copy of the criteria. Rewords supersede; nothing is deleted. */
export function applyActions(criteria: Criterion[], actions: ClassifiedAction[], revision: number, commentId: number | null): Applied {
  const next: Criterion[] = criteria.map((c) => ({ ...c }));
  const affected: string[] = [];
  const summary: string[] = [];
  let rerunAll = false;
  let nextId = next.reduce((m, c) => Math.max(m, Number(/(\d+)$/.exec(c.id)?.[1] ?? 0)), 0) + 1;
  const source = (a: ClassifiedAction) => ({ input: "comment" as const, ref: commentId != null ? String(commentId) : undefined, excerpt: a.actedOnText.slice(0, 300) });
  const find = (id?: string) => (id ? next.find((c) => c.id === id && !c.supersededBy) : undefined);
  const exists = (text: string) => next.some((c) => !c.supersededBy && !c.notApplicable && (norm(c.text) === norm(text) || norm(c.text).includes(norm(text)) || norm(text).includes(norm(c.text))));
  for (const a of actions) {
    if (a.confidence < CONFIDENCE_THRESHOLD) continue;
    if (a.action === "rerun") {
      rerunAll = true;
      summary.push("re-running verification for every criterion");
    } else if (a.action === "add_criterion" && a.text) {
      if (exists(a.text)) continue;
      const id = String(nextId++);
      next.push({ id, text: a.text, met: null, evidence: null, kind: "code", implied: false, revision, source: source(a) });
      affected.push(id);
      summary.push(`added ${id}: ${a.text}`);
    } else if (a.action === "reword_criterion" && a.text) {
      const target = find(a.criterionId);
      if (!target || norm(target.text) === norm(a.text)) continue;
      const id = String(nextId++);
      next.push({ id, text: a.text, met: null, evidence: null, kind: target.kind ?? "code", implied: !!target.implied, revision, source: source(a) });
      target.supersededBy = id;
      affected.push(id);
      summary.push(`reworded ${target.id} → ${id}: "${target.text}" → "${a.text}"`);
    } else if (a.action === "remove_criterion" || a.action === "mark_not_applicable") {
      const target = find(a.criterionId);
      if (!target || target.notApplicable) continue;
      target.notApplicable = true;
      target.revision = revision;
      summary.push(`marked ${target.id} not applicable: ${target.text}`);
    }
  }
  return { criteria: next, affectedIds: affected, rerunAll, summary };
}

function classifyUserPrompt(review: { prTitle: string; prNumber: number }, criteria: Criterion[], run: VerifyRun | null, comment: MaintainerComment): string {
  const verdict = new Map((run?.verdicts ?? []).map((v) => [v.criterionId, v]));
  return [
    `# PR #${review.prNumber}: ${review.prTitle}`,
    "",
    "## Acceptance criteria and their verification verdicts",
    ...criteria.filter((c) => !c.supersededBy).map((c) => `- [${c.id}] ${c.text} — verdict: ${c.notApplicable ? "not applicable" : verdict.get(c.id)?.verdict ?? "pending"}${verdict.get(c.id)?.reason ? ` (${verdict.get(c.id)!.reason})` : ""}`),
    "",
    `## Comment by ${comment.author} (${comment.authorAssociation})`,
    "## Comment",
    comment.body,
  ].join("\n");
}

const defaultLLM = async ({ system, user }: { system: string; user: string }) =>
  (await completeWithMeta({ system, cacheSystem: true, maxTokens: 1500, messages: [{ role: "user", content: user }] })).text;

const defaultPostReply = (install: Installation, repo: Repository, prNumber: number, body: string) =>
  postPRCommentReturningId(install.installationId, repo.owner, repo.name, prNumber, body);

const defaultDispatch = (install: Installation, repo: Repository, payload: Record<string, unknown>) =>
  repositoryDispatch(install.installationId, repo.owner, repo.name, DISPATCH_EVENT, payload);

function record(row: Omit<PRCommentAction, "id" | "schemaVersion" | "createdAt">): PRCommentAction {
  return db.insert("prCommentActions", { id: uuid(), schemaVersion: 1, createdAt: Date.now(), ...row });
}

/** Called after the legacy maintainer-feedback job: hand the comment to the verify loop when this PR is verified. */
export function enqueueVerifyFeedbackIfEligible(reviewId: string, comment: MaintainerComment): boolean {
  const review = db.find("prReviews", (r) => r.id === reviewId);
  const repo = review ? db.find("repositories", (r) => r.id === review.repoId) : null;
  if (!review || !repo || !effectiveWorkflow(repo).stages.verify) return false;
  if (!latestRunForReview(review.id)) return false;
  enqueueVerifyFeedback(review.id, comment);
  return true;
}

export type FeedbackOutcome = { outcome: PRCommentAction["outcome"] | "no_run" | "bot"; revision?: number; runId?: string; replyCommentId?: number | null };

export async function runVerifyFeedback(reviewId: string, comment: MaintainerComment, deps: FeedbackDeps = {}): Promise<FeedbackOutcome> {
  const review = db.find("prReviews", (r) => r.id === reviewId);
  const repo = review ? db.find("repositories", (r) => r.id === review.repoId) : null;
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  if (!review || !repo) return { outcome: "no_run" };
  if (isBotLogin(comment.author)) return { outcome: "bot" };
  const latest = latestRunForReview(review.id);
  if (!latest) return { outcome: "no_run" };
  const commentId = comment.commentId ?? null;
  const surface: PRCommentAction["surface"] = comment.sourceEvent === "pull_request_review_comment" ? "review_comment" : "issue_comment";

  // One re-run in flight per PR: later comments wait for it.
  const inFlight = db.find("verifyRuns", (r) => r.reviewId === review.id && IN_FLIGHT.has(r.status));
  if (inFlight) {
    record({ reviewId: review.id, githubCommentId: commentId ?? 0, surface, authorLogin: comment.author, body: comment.body.slice(0, 4000), classified: [], outcome: "queued", queuedComment: comment, handledAt: null });
    return { outcome: "queued" };
  }

  const llm = deps.llm ?? defaultLLM;
  const postReply = deps.postReply ?? defaultPostReply;
  const { actions, reply } = await withModel(modelForPlan(latest.planTier), () =>
    withUsage(async () => normalizeActions(extractJSON(await llm({ system: verificationFeedbackSystemPrompt(), user: classifyUserPrompt(review, review.criteria, latest, comment) }))))
  );
  const runUrl = runDeepLink(review.id, latest.id);
  const base = { reviewId: review.id, githubCommentId: commentId ?? 0, surface, authorLogin: comment.author, body: comment.body.slice(0, 4000), classified: actions };
  const say = async (body: string) => (install ? await postReply(install, repo, review.prNumber, body) : null);

  const changes = actions.filter((a) => a.action !== "ignore" && a.action !== "question");
  const question = actions.find((a) => a.action === "question");
  if (!changes.length && !question) {
    record({ ...base, outcome: "ignored", handledAt: Date.now() });
    return { outcome: "ignored" };
  }
  if (!changes.length && question) {
    const replyCommentId = await say(`${reply || "The verdicts come from the tests that ran; each criterion links to its evidence."}\n\n[Verification details](${runUrl})`);
    record({ ...base, outcome: "answered", replyCommentId, handledAt: Date.now() });
    return { outcome: "answered", replyCommentId };
  }
  const confident = changes.filter((a) => a.confidence >= CONFIDENCE_THRESHOLD);
  if (!confident.length) {
    const guesses = changes.map((a) => `- ${a.action.replace(/_/g, " ")}${a.criterionId ? ` (criterion ${a.criterionId})` : ""}${a.text ? `: "${a.text}"` : ""}`).join("\n");
    const replyCommentId = await say(`I read this as a change to the verification criteria but I'm not sure which:\n${guesses}\n\nReply with the criterion and the wording you want, or "re-run" to run the same criteria again.`);
    record({ ...base, outcome: "clarification_requested", replyCommentId, handledAt: Date.now() });
    return { outcome: "clarification_requested", replyCommentId };
  }

  // Apply as a new revision; never mutate the original rows in place.
  const nextRevision = (db.filter("criteriaRevisions", (c) => c.reviewId === review.id).reduce((m, c) => Math.max(m, c.revision), 0) || 1) + 1;
  const applied = applyActions(review.criteria, confident, nextRevision, commentId);
  const changed = applied.summary.length > 0;
  if (changed) db.update("prReviews", (r) => r.id === review.id, { criteria: applied.criteria, updatedAt: Date.now() });
  const revision = changed ? snapshotCriteriaRevision(review.id, applied.criteria, commentId) : null;
  const affected = applied.rerunAll ? applied.criteria.filter(isVerifiable).map((c) => c.id) : applied.affectedIds;
  if (!changed && !applied.rerunAll) {
    record({ ...base, outcome: "ignored", handledAt: Date.now() });
    return { outcome: "ignored" };
  }

  const run = createVerifyRun({
    review: { ...review, headSha: review.headSha },
    repo,
    install,
    status: affected.length ? "planning" : "judging",
    criteriaRevision: revision?.revision ?? latest.criteriaRevision,
    triggeredBy: { kind: "comment", ...(commentId != null ? { commentId } : {}) },
    inheritFromRunId: latest.id,
  });
  db.insert("reviewLogs", { id: uuid(), reviewId: review.id, kind: "verify", at: Date.now(), action: `Criteria revised from a PR comment (revision ${revision?.revision ?? latest.criteriaRevision})`, detail: applied.summary.join("\n"), meta: { runId: run.id, commentId, affected } });

  const lines = [
    `Adjusted the verification criteria from your comment${revision ? ` (revision ${revision.revision})` : ""}:`,
    ...applied.summary.map((s) => `- ${s}`),
    "",
    affected.length
      ? `Re-running verification for ${affected.length} criteri${affected.length === 1 ? "on" : "a"} — this comment will be updated with the verdicts.`
      : "No tests need to re-run; the verification summary on this PR has been updated.",
    "",
    `[Verification details](${runDeepLink(review.id, run.id)})`,
  ];
  const replyCommentId = await say(lines.join("\n"));
  record({ ...base, outcome: "applied", revision: revision?.revision, replyCommentId, handledAt: Date.now() });

  if (!affected.length) {
    // Nothing to run: inherit every verdict and report right away.
    const { runVerifyJudge } = await import("./judge.js");
    db.insert("verifyResults", { id: uuid(), schemaVersion: 1, runId: run.id, payload: { runId: run.id, sha: run.sha, planId: null, cliVersion: "server", results: [], existingTestsTouchingDiff: [], timings: { startedAt: Date.now(), finishedAt: Date.now() } }, createdAt: Date.now() });
    const results = db.find("verifyResults", (r) => r.runId === run.id)!;
    updateRun(run.id, { resultsId: results.id });
    await runVerifyJudge(run.id);
    return { outcome: "applied", revision: revision?.revision, runId: run.id, replyCommentId };
  }

  const planned = deps.plan ? await deps.plan(run.id, affected) : await runVerifyPlan(run.id, { onlyCriteriaIds: affected });
  const fresh = db.find("verifyRuns", (r) => r.id === run.id);
  if (fresh?.status === "awaiting_runner" && install) {
    try {
      await (deps.dispatch ?? defaultDispatch)(install, repo, { pr: review.prNumber, sha: review.headSha, runId: run.id, reviewId: review.id });
      db.insert("reviewLogs", { id: uuid(), reviewId: review.id, kind: "verify", at: Date.now(), action: "Runner re-triggered via repository_dispatch", meta: { runId: run.id } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[verify] repository_dispatch failed for ${repo.owner}/${repo.name}:`, msg);
      db.insert("reviewLogs", { id: uuid(), reviewId: review.id, kind: "verify", at: Date.now(), action: "Could not re-trigger the runner", detail: `${msg.slice(0, 300)} — the workflow needs a repository_dispatch trigger and the App needs contents:write; push a commit to re-run instead.`, meta: { runId: run.id } });
    }
  }
  void planned;
  await rerenderReport(run.id).catch(() => {});
  return { outcome: "applied", revision: revision?.revision, runId: run.id, replyCommentId };
}

/** After a run settles: update the reply under the triggering comment, then process the next queued comment. */
export async function afterFeedbackRunSettled(run: VerifyRun, deps: { updateReply?: (install: Installation, repo: Repository, commentId: number, body: string) => Promise<boolean> } = {}): Promise<void> {
  const review = db.find("prReviews", (r) => r.id === run.reviewId);
  const repo = review ? db.find("repositories", (r) => r.id === review.repoId) : null;
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  if (!review || !repo) return;
  if (run.triggeredBy.kind === "comment" && run.triggeredBy.commentId != null && install) {
    const row = db.find("prCommentActions", (c) => c.reviewId === review.id && c.githubCommentId === run.triggeredBy.commentId && c.outcome === "applied");
    if (row?.replyCommentId) {
      const plan = run.planId ? db.find("verifyPlans", (p) => p.id === run.planId) : null;
      const affected = new Set([...(plan?.tests ?? []).flatMap((t) => t.criterionIds), ...(plan?.unverifiable ?? []).map((u) => u.criterionId)]);
      const text = new Map(review.criteria.map((c) => [c.id, c.text]));
      const lines = run.verdicts.filter((v) => !affected.size || affected.has(v.criterionId)).map((v) => `- **${v.criterionId}.** ${text.get(v.criterionId) ?? ""} — **${v.verdict === "fail" ? "FAIL" : v.verdict}**${v.reason ? ` · ${v.reason}` : ""} · [details](${runDeepLink(review.id, run.id, v.criterionId)})`);
      const body = `Adjusted the verification criteria from your comment (revision ${run.criteriaRevision}).\n\n**Updated verification**\n${lines.join("\n") || "- no verifiable criteria"}\n\n[Verification details](${runDeepLink(review.id, run.id)})`;
      const update = deps.updateReply ?? (async (i, r, id, b) => (await import("../github/app.js")).updatePRComment(i.installationId, r.owner, r.name, id, b));
      await update(install, repo, row.replyCommentId, body).catch(() => false);
    }
  }
  const queued = db.filter("prCommentActions", (c) => c.reviewId === review.id && c.outcome === "queued").sort((a, b) => a.createdAt - b.createdAt)[0];
  if (queued?.queuedComment) {
    db.update("prCommentActions", (c) => c.id === queued.id, { outcome: "ignored", handledAt: Date.now() }); // superseded by the re-enqueued copy
    enqueueVerifyFeedback(review.id, queued.queuedComment);
  }
}
