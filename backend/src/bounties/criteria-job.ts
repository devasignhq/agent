// Drafts a bounty's acceptance criteria from its GitHub issue plus the repo's
// index, so the sponsor has something concrete to review on the funding page
// instead of an empty list.
//
// Runs once, right after createBounty, off the request thread. The sponsor can
// fund at ANY point while this is in flight or after it has failed — criteria
// are a nudge, never a gate. Money must never wait on an LLM.
//
// Shape follows runLinearIngestJob (review/pipeline.ts): fetch context ->
// synthesizeCriteriaCore -> persist, wrapped in withModel/withUsage so the spend
// tiers by plan and rolls into analytics.
import { config } from "../config.js";
import { db } from "../db.js";
import { gh } from "../github/app.js";
import { withModel, withUsage } from "../llm.js";
import { modelForPlan, planForUser } from "../billing/plans.js";
import { buildGuidanceSection } from "../review/guidance.js";
import { effectiveWorkflow } from "../review/workflow.js";
import { synthesizeCriteriaCore, type IngestedSource } from "../review/pipeline.js";
import { track } from "../statsig.js";
import type { Bounty, Repository } from "../types.js";
import { getBounty, patchBounty, recordBountyEvent } from "./service.js";
import { bountyActor, resolveBountyOwner } from "./owner.js";
import { renderRepoContext, selectRepoContext } from "./criteria-context.js";
import { lintCriteria } from "./criteria-lint.js";
import { MAX_CRITERIA, MAX_CRITERION_CHARS } from "./acceptance.js";

const MAX_ISSUE_COMMENTS = 20;
const MAX_COMMENT_CHARS = 2000;

/**
 * Issue comments, best-effort. The webhook payload carries only title + body,
 * but the real specification is often in the discussion ("we decided X
 * instead"), so it is worth one extra call. Never throws — a private repo, a
 * revoked install or a rate limit degrades to issue-only criteria.
 */
async function fetchIssueComments(bounty: Bounty): Promise<IngestedSource[]> {
  if (bounty.source !== "github" || !bounty.installationId || !bounty.issueNumber) return [];
  const [owner, name] = bounty.repo.split("/");
  try {
    const rows = await gh<any[]>(
      bounty.installationId,
      `/repos/${owner}/${name}/issues/${bounty.issueNumber}/comments?per_page=30`
    );
    if (!Array.isArray(rows)) return [];
    const out: IngestedSource[] = [];
    for (const row of rows) {
      if (out.length >= MAX_ISSUE_COMMENTS) break;
      // Skip bots — above all our OWN confirm comment, or the model reads
      // "Fund bounty ->" as part of the specification.
      if (row?.user?.type === "Bot") continue;
      if (bounty.botCommentId && row?.id === bounty.botCommentId) continue;
      const body = typeof row?.body === "string" ? row.body.trim() : "";
      if (!body) continue;
      const author = typeof row?.user?.login === "string" ? row.user.login : "unknown";
      out.push({
        kind: "github_issue",
        ref: `${bounty.repo}#${bounty.issueNumber} comment by ${author}`,
        text: body.slice(0, MAX_COMMENT_CHARS),
      });
    }
    return out;
  } catch (err) {
    console.warn(`[bounty] ${bounty.code}: issue comments fetch failed:`, err);
    return [];
  }
}

/**
 * `repo_context` sources ranked against the issue text.
 *
 * Gated on indexState exactly like gatherHolisticContext: `queued`/`indexing`
 * means a PARTIAL index, and half a repo is more misleading than none. An
 * unindexed repo deliberately does NOT trigger a build here — that is minutes
 * and real money while a sponsor waits on a page.
 */
function repoContextSources(repo: Repository | null, issueText: string): IngestedSource[] {
  if (!repo) return [];
  const state = repo.indexState ?? "none";
  if (state !== "ready" && state !== "stale") return [];
  const entries = db.filter("repoIndex", (e) => e.repoId === repo.id);
  if (!entries.length) return [];
  return renderRepoContext(selectRepoContext(issueText, entries));
}

function buildSources(bounty: Bounty, repo: Repository | null, comments: IngestedSource[]): IngestedSource[] {
  const sources: IngestedSource[] = [];
  const body = (bounty.description || "").trim();
  sources.push({
    kind: "github_issue_primary",
    ref: bounty.issueNumber ? `${bounty.repo}#${bounty.issueNumber}` : bounty.repo,
    text: `${bounty.title}\n\n${body}`.trim(),
  });
  sources.push(...comments);

  if (repo) {
    const guidance = buildGuidanceSection(repo);
    if (guidance) sources.push({ kind: "repo_guidance", ref: "repository guidance", text: guidance });
  }

  // Rank repo files against the issue's own words only — comments and guidance
  // would dilute the signal with process chatter.
  sources.push(...repoContextSources(repo, `${bounty.title}\n${body}`));
  return sources;
}

/**
 * Injectable synthesis, so the two failure branches below (unparseable response,
 * hard throw) are reachable from tests. The offline mock always returns a valid
 * criteria payload, so without this seam neither branch could be exercised —
 * and "never leave the row stuck in generating" is the invariant that keeps the
 * funding page from spinning forever.
 */
export type CriteriaJobDeps = { synthesize?: typeof synthesizeCriteriaCore };

/**
 * Draft acceptance criteria for one bounty. Idempotent by state: it only ever
 * acts on a bounty still marked "generating", and re-checks that after the
 * model call, so a sponsor who edits mid-flight is never clobbered.
 */
export async function runBountyCriteriaJob(bountyId: string, deps: CriteriaJobDeps = {}): Promise<void> {
  const synthesize = deps.synthesize ?? synthesizeCriteriaCore;
  const bounty = getBounty(bountyId);
  if (!bounty) return;
  // Compare-and-set: anything else means the sponsor already saved their own
  // list (or another worker got here first). Their words win over ours.
  if (bounty.acceptanceState !== "generating") return;

  const { repo, userId } = resolveBountyOwner(bounty);
  const model = userId ? modelForPlan(planForUser(userId)) : config.llm.model;

  try {
    await withModel(model, () =>
      withUsage(async () => {
        const comments = await fetchIssueComments(bounty);
        const sources = buildSources(bounty, repo, comments);
        const hasAuthoritativeSpec = Boolean((bounty.description || "").trim());

        const { endGoal, criteria } = await synthesize({
          title: bounty.title,
          sources,
          hasAuthoritativeSpec,
          mode: "bounty",
          // The maintainer's own criteria steering. The review pipeline threads
          // this into synthesis, but the bounty-seed path bypasses synthesis
          // entirely — so without this a maintainer's custom instructions would
          // silently stop applying to bounty PRs.
          extraInstructions: repo ? effectiveWorkflow(repo).prompts?.criteria : undefined,
        });

        // Re-read: the model call takes seconds, and the sponsor may have saved
        // their own list in that window.
        const fresh = getBounty(bountyId);
        if (!fresh || fresh.acceptanceState !== "generating") {
          console.log(`[bounty] ${bounty.code}: criteria draft discarded — the sponsor edited first`);
          return;
        }

        // synthesizeCriteriaCore parses through tryParseJSON, which falls back to
        // {endGoal:"", criteria:[]} on malformed JSON — indistinguishable from a
        // legitimate "too vague to judge" result. The prompt guarantees a
        // non-empty endGoal EVEN when criteria is empty, so an empty one means
        // the response never parsed. Treat that as a failure, not a result:
        // persisting it would tell the sponsor their issue was too vague when
        // the model actually failed.
        if (!endGoal.trim()) {
          throw new Error("criteria synthesis returned no endGoal (unparseable response)");
        }

        const acceptance = criteria
          .map((c) => c.text.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .filter((t) => t.length <= MAX_CRITERION_CHARS)
          .slice(0, MAX_CRITERIA);

        patchBounty(bountyId, { acceptance, acceptanceEndGoal: endGoal, acceptanceState: "ready" });
        recordBountyEvent(bountyId, "criteria_drafted", {
          actor: "system",
          detail: acceptance.length ? `${acceptance.length} criteria` : "no criteria — issue too vague",
        });

        // Structural quality signal. Advisory only: a nagging linter must never
        // stand between a sponsor and funding, so this is logged, not enforced.
        const lint = lintCriteria(acceptance, endGoal);
        if (lint.length) {
          console.warn(
            `[bounty] ${bounty.code}: criteria lint — ${lint.map((f) => `${f.lint}${f.index != null ? `#${f.index}` : ""}`).join(", ")}`
          );
        }
        track(bountyActor(bounty), "bounty criteria drafted", {
          repo: bounty.repo,
          criteria_count: acceptance.length,
          lint_count: lint.length,
          had_repo_context: sources.some((s) => s.kind === "repo_context"),
          had_issue_comments: comments.length > 0,
          model,
        });
      })
    );
  } catch (err) {
    console.error(`[bounty] ${bounty.code}: criteria drafting failed:`, err);
    // Never leave the row stuck in "generating" — the fund page would spin
    // forever. Only claim the failure if nobody else has moved the state on.
    if (getBounty(bountyId)?.acceptanceState === "generating") {
      patchBounty(bountyId, { acceptanceState: "errored" });
    }
  }
}
