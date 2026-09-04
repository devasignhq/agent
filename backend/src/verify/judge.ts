// Judgment: verdicts are computed from what actually ran; the model writes the
// reason, picks evidence, and may only DOWNGRADE to unverifiable. A test that
// broke is not a PR that is wrong: error/flaky map to unverifiable, never fail.
import { db } from "../db.js";
import { config } from "../config.js";
import { completeWithMeta, withModel, withUsage } from "../llm.js";
import { modelForPlan } from "../billing/plans.js";
import { extractJSON } from "../review/parse.js";
import { verificationJudgmentSystemPrompt } from "../review/prompts.js";
import { withMaintainerInstructions } from "../review/decisions.js";
import { effectiveWorkflow } from "../review/workflow.js";
import type { Criterion, CriterionVerdict, VerifyArtifact, VerifyPlan, VerifyRun } from "../types.js";
import type { DoctorDiagnosis, RunnerResult } from "./contract.js";
import { recordFlakeOutcome } from "./flake.js";
import { usageByProvider } from "./plan.js";
import { rerenderReport } from "./report.js";
import { criteriaForRun, updateRun } from "./runs.js";
import { artifactStorage } from "./storage.js";
import { notifyForReview } from "../notifications.js";
import { v4 as uuid } from "uuid";

export const FLAKY_REASON = "flaky test — quarantined";

const EVIDENCE_KIND_ORDER: VerifyArtifact["kind"][] = ["log", "screenshot", "test_file", "video", "trace", "poster"];

function isVerifiable(c: Criterion): boolean {
  return (c.kind ?? "code") !== "unverifiable" && !c.notApplicable && !c.supersededBy;
}

function artifactsFor(result: RunnerResult, artifacts: VerifyArtifact[], attemptsOnly = false): string[] {
  const ids = new Set<string>();
  for (const a of result.attempts) for (const id of a.artifactIds) ids.add(id);
  if (!attemptsOnly) {
    for (const id of result.artifactIds) ids.add(id);
    for (const a of artifacts) if (a.testId === result.testId && a.kind === "test_file") ids.add(a.id);
  }
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  return [...ids]
    .filter((id) => byId.has(id))
    .sort((x, y) => EVIDENCE_KIND_ORDER.indexOf(byId.get(x)!.kind) - EVIDENCE_KIND_ORDER.indexOf(byId.get(y)!.kind));
}

export function computeVerdicts(args: {
  criteria: Criterion[];
  results: RunnerResult[];
  plan: VerifyPlan | null;
  doctor: DoctorDiagnosis | null;
  artifacts: VerifyArtifact[];
}): CriterionVerdict[] {
  const out: CriterionVerdict[] = [];
  const planned = new Map((args.plan?.unverifiable ?? []).map((u) => [u.criterionId, u.reason]));
  for (const c of args.criteria) {
    if (!isVerifiable(c)) continue;
    const covering = args.results.filter((r) => r.criterionIds.includes(c.id));
    if (args.doctor) {
      out.push({ criterionId: c.id, verdict: "unverifiable", reason: `setup needs attention: ${args.doctor.message}`.slice(0, 300), evidenceRefs: args.doctor.logArtifactId ? [{ artifactId: args.doctor.logArtifactId }] : [] });
      continue;
    }
    if (!covering.length) {
      out.push({ criterionId: c.id, verdict: "unverifiable", reason: planned.get(c.id) ?? "no test ran for this criterion", evidenceRefs: [] });
      continue;
    }
    const flaky = covering.filter((r) => r.status === "flaky");
    const failed = covering.filter((r) => r.status === "fail");
    const passed = covering.filter((r) => r.status === "pass");
    const errored = covering.filter((r) => r.status === "error" || r.status === "skipped");
    const refs = (rs: RunnerResult[], attemptsOnly = false) =>
      rs.flatMap((r) => [
        { testId: r.testId, resultId: r.id },
        ...artifactsFor(r, args.artifacts, attemptsOnly).map((artifactId) => ({ artifactId, testId: r.testId, resultId: r.id })),
      ]);
    if (flaky.length && !failed.length) {
      out.push({ criterionId: c.id, verdict: "unverifiable", reason: FLAKY_REASON, evidenceRefs: refs(flaky), flaky: true });
      continue;
    }
    if (failed.length) {
      const first = failed[0];
      const attempts = first.attempts.length || first.attempts.length;
      out.push({
        criterionId: c.id,
        verdict: "fail",
        reason: `assertion failed on ${attempts > 1 ? `all ${attempts} attempts` : "the test run"}: ${(first.error || first.attempts.at(-1)?.error || "see log").split("\n")[0]}`.slice(0, 300),
        evidenceRefs: refs(failed),
      });
      continue;
    }
    if (passed.length && !errored.length) {
      out.push({ criterionId: c.id, verdict: "pass", reason: `${passed.length === 1 ? "the test" : `${passed.length} tests`} passed`, evidenceRefs: refs(passed) });
      continue;
    }
    if (passed.length && errored.length) {
      out.push({ criterionId: c.id, verdict: "pass", reason: `${passed.length} test(s) passed; ${errored.length} could not run`, evidenceRefs: refs([...passed, ...errored]) });
      continue;
    }
    const e = errored[0];
    out.push({
      criterionId: c.id,
      verdict: "unverifiable",
      reason: `test could not run: ${(e.error || e.attempts.at(-1)?.error || e.status).split("\n")[0]}`.slice(0, 300),
      evidenceRefs: refs(errored),
    });
  }
  return out;
}

export type ModelVerdict = { criterionId: string; verdict: string; reason: string; evidenceArtifactIds: string[] };

/** Downgrade-only merge: the model can turn pass/fail into unverifiable and refine reason/evidence, nothing else. */
export function mergeModelVerdicts(code: CriterionVerdict[], model: ModelVerdict[], artifacts: VerifyArtifact[]): CriterionVerdict[] {
  const byId = new Map(model.map((m) => [m.criterionId, m]));
  const known = new Set(artifacts.map((a) => a.id));
  return code.map((v) => {
    const m = byId.get(v.criterionId);
    if (!m) return v;
    const reason = typeof m.reason === "string" && m.reason.trim() ? m.reason.trim().slice(0, 300) : v.reason;
    const picked = (m.evidenceArtifactIds || []).filter((id) => known.has(id));
    const evidenceRefs = picked.length
      ? [...v.evidenceRefs.filter((r) => !r.artifactId), ...picked.map((artifactId) => ({ artifactId }))]
      : v.evidenceRefs;
    if (v.verdict !== "unverifiable" && m.verdict === "unverifiable") {
      return { ...v, verdict: "unverifiable", reason, evidenceRefs };
    }
    return { ...v, reason: v.verdict === "unverifiable" && v.flaky ? v.reason : reason, evidenceRefs };
  });
}

export type JudgeDeps = {
  llm?: (args: { system: string; user: string; images: Array<{ mediaType: string; base64: string }> }) => Promise<string>;
  fetchBytes?: (url: string, maxBytes: number) => Promise<Buffer | null>;
};

async function defaultFetchBytes(url: string, maxBytes: number): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  } catch {
    return null;
  }
}

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_LOG_BYTES = 20 * 1024;

export function buildJudgeUserPrompt(args: {
  criteria: Criterion[];
  code: CriterionVerdict[];
  results: RunnerResult[];
  artifacts: VerifyArtifact[];
  logs: Map<string, string>;
  doctor: DoctorDiagnosis | null;
}): string {
  const byId = new Map(args.artifacts.map((a) => [a.id, a]));
  const lines: string[] = ["# Verification evidence", ""];
  if (args.doctor) lines.push(`Runner diagnosis: [${args.doctor.stage}/${args.doctor.code}] ${args.doctor.message}`, "");
  for (const v of args.code) {
    const c = args.criteria.find((x) => x.id === v.criterionId);
    lines.push(`- [${v.criterionId}] provisional: ${v.verdict} — ${c?.text ?? ""}`);
    lines.push(`  mechanical reason: ${v.reason}`);
    for (const r of args.results.filter((r) => r.criterionIds.includes(v.criterionId))) {
      lines.push(`  test ${r.test || r.testId} (${r.level}, ${r.origin}, ${r.runner}): ${r.status}, ${r.attempts.length} attempt(s)`);
      for (const a of r.attempts) lines.push(`    attempt ${a.n}: ${a.status} in ${a.durationMs}ms${a.error ? ` — ${a.error.split("\n").slice(0, 3).join(" ").slice(0, 400)}` : ""}`);
      for (const id of new Set([...r.artifactIds, ...r.attempts.flatMap((a) => a.artifactIds)])) {
        const art = byId.get(id);
        if (!art) continue;
        lines.push(`    artifact ${art.id}: ${art.kind} ${art.path}`);
        const log = args.logs.get(art.id);
        if (log) lines.push("    ```", ...log.split("\n").slice(0, 60).map((l) => "    " + l.slice(0, 300)), "    ```");
      }
    }
  }
  return lines.join("\n");
}

export async function runVerifyJudge(runId: string, deps: JudgeDeps = {}): Promise<VerifyRun | null> {
  const run = db.find("verifyRuns", (r) => r.id === runId);
  if (!run || run.status !== "judging") return run ?? null;
  const repo = db.find("repositories", (r) => r.id === run.repoId);
  if (!repo) return updateRun(run.id, { status: "failed", error: "repository row missing" });
  const results = run.resultsId ? db.find("verifyResults", (r) => r.id === run.resultsId) : null;
  if (!results) return updateRun(run.id, { status: "failed", error: "results row missing" });
  const plan = run.planId ? db.find("verifyPlans", (p) => p.id === run.planId) : null;
  const artifacts = db.filter("verifyArtifacts", (a) => a.runId === run.id && a.state === "uploaded");
  const { criteria } = criteriaForRun(run);
  const doctor = results.payload.doctor ?? null;

  const code = computeVerdicts({ criteria, results: results.payload.results, plan, doctor, artifacts });

  // Flake history: every generated test's outcome, by signature.
  const testById = new Map((plan?.tests ?? []).map((t) => [t.id, t]));
  const critText = new Map(criteria.map((c) => [c.id, c.text]));
  for (const r of results.payload.results) {
    const t = testById.get(r.testId);
    if (!t || t.origin !== "generated") continue;
    const outcome = r.status === "skipped" ? "error" : r.status;
    recordFlakeOutcome({
      repoId: repo.id,
      signature: t.testSignature,
      runId: run.id,
      outcome,
      strategyVersion: t.strategyVersion,
      criterionText: t.criterionIds.map((id) => critText.get(id) || "").join(" | "),
      level: t.level,
      targetFiles: t.targetFiles,
    });
  }

  return withModel(modelForPlan(run.planTier), () =>
    withUsage(async () => {
      let verdicts = code;
      try {
        const storage = artifactStorage();
        const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
        const logs = new Map<string, string>();
        const images: Array<{ mediaType: string; base64: string }> = [];
        if (storage && code.length) {
          const wanted = new Set(code.flatMap((v) => v.evidenceRefs.map((r) => r.artifactId).filter((id): id is string => !!id)));
          const uiIds = new Set(criteria.filter((c) => c.kind === "ui").map((c) => c.id));
          for (const a of artifacts) {
            if (!wanted.has(a.id)) continue;
            if (a.kind === "log") {
              const buf = await fetchBytes(await storage.signGet(a.storageKey, config.artifacts.getUrlTtlSeconds), MAX_LOG_BYTES);
              if (buf) logs.set(a.id, buf.toString("utf8"));
            } else if (a.kind === "screenshot" && images.length < MAX_IMAGES && a.criterionIds.some((id) => uiIds.has(id))) {
              const buf = await fetchBytes(await storage.signGet(a.storageKey, config.artifacts.getUrlTtlSeconds), MAX_IMAGE_BYTES);
              if (buf && buf.length <= MAX_IMAGE_BYTES) images.push({ mediaType: a.contentType.startsWith("image/") ? a.contentType : "image/png", base64: buf.toString("base64") });
            }
          }
        }
        const wf = effectiveWorkflow(repo);
        const system = withMaintainerInstructions(verificationJudgmentSystemPrompt(), wf.prompts?.verify);
        const user = buildJudgeUserPrompt({ criteria, code, results: results.payload.results, artifacts, logs, doctor });
        const text = deps.llm
          ? await deps.llm({ system, user, images })
          : (await completeWithMeta({ system, cacheSystem: true, maxTokens: 4_000, messages: [{ role: "user", content: user }], images })).text;
        const parsed = extractJSON(text) as { verdicts?: ModelVerdict[] } | null;
        if (parsed && Array.isArray(parsed.verdicts)) verdicts = mergeModelVerdicts(code, parsed.verdicts, artifacts);
      } catch (err) {
        console.warn(`[verify] judgment model call failed for run ${run.id}; keeping mechanical verdicts:`, err);
      }
      const judgedAt = Date.now();
      const updated = updateRun(run.id, {
        status: "completed",
        verdicts,
        timings: { ...run.timings, judgedAt },
        tokenUsage: { ...run.tokenUsage, judge: usageByProvider() },
      });
      const counts = { pass: 0, fail: 0, unverifiable: 0 };
      for (const v of verdicts) counts[v.verdict] += 1;
      db.insert("reviewLogs", {
        id: uuid(),
        reviewId: run.reviewId,
        kind: "verify",
        at: judgedAt,
        action: `Verification complete: ${counts.pass} passed, ${counts.fail} failed, ${counts.unverifiable} unverifiable`,
        detail: verdicts.map((v) => `[${v.criterionId}] ${v.verdict}: ${v.reason}`).join("\n"),
        meta: { runId: run.id, ...counts, doctor: doctor?.code ?? null },
      });
      try {
        await rerenderReport(run.id);
      } catch (err) {
        console.warn("[verify] rerenderReport failed:", err);
      }
      notifyForReview(
        run.reviewId,
        counts.fail ? "blocker" : "review",
        `PR #${run.prNumber} — Verification: ${counts.pass} passed, ${counts.fail} failed, ${counts.unverifiable} unverifiable`,
        doctor ? `Setup needs attention: ${doctor.message}` : verdicts.map((v) => `[${v.criterionId}] ${v.verdict}`).join(" · "),
        `/reviews/${run.reviewId}?run=${run.id}`
      );
      return updated;
    })
  );
}
