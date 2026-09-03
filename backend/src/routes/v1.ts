// /v1 — the runner-facing API (@devasign/verify). Authenticated by GitHub
// Actions OIDC, not the session cookie; mounted before the global JSON parser
// so results payloads get their own body limit.
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { getSessionUser } from "../github/oauth.js";
import { installationsForUser, userInInstall } from "../github/installations.js";
import { effectiveWorkflow } from "../review/workflow.js";
import { enqueueVerifyJudge } from "../queue.js";
import { runnerLimiter } from "../rate-limit.js";
import type { Installation, Repository, VerifyArtifact, VerifyArtifactKind } from "../types.js";
import { prNumberFromRef, verifyActionsToken, type ActionsClaims, type OidcResult } from "../verify/oidc.js";
import { artifactKey, artifactStorage, retentionExpiresAt, UPLOAD_LIMITS } from "../verify/storage.js";
import { localArtifactPath, localStoreEnabled, verifyLocalSignature } from "../verify/storage-local.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildRunView,
  latestRunForReview,
  planTierForRepo,
  runnerPlanFor,
  TERMINAL_STATUSES,
  updateRun,
} from "../verify/runs.js";
import type {
  ApiError,
  ArtifactSignFile,
  ArtifactSignResponse,
  ResolveRequest,
  ResolveResponse,
  ResultsResponse,
  RunnerResults,
} from "../verify/contract.js";
import type { Plan } from "../billing/plans.js";

export type RunnerIdentity = { claims: ActionsClaims; repo: Repository; install: Installation | null; plan: Plan };

type RunnerRequest = Request & { runner?: RunnerIdentity };

const ALLOWED_EVENTS = new Set(["pull_request", "repository_dispatch", "workflow_dispatch"]);
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const ARTIFACT_KINDS: ReadonlySet<string> = new Set<VerifyArtifactKind>(["video", "trace", "screenshot", "log", "test_file", "poster"]);

function fail(res: Response, status: number, error: string, extra: Partial<ApiError> = {}): void {
  res.status(status).json({ ok: false, error, ...extra } satisfies ApiError);
}

/** The repository an OIDC token speaks for. Learns githubRepoId from a signed token when a row lacks it. */
export function repoForClaims(claims: Pick<ActionsClaims, "repository" | "repository_id">): Repository | null {
  const ghId = Number(claims.repository_id);
  const byId = Number.isFinite(ghId) ? db.find("repositories", (r) => r.githubRepoId === ghId) : null;
  if (byId) return byId;
  const [owner, name] = String(claims.repository || "").split("/");
  if (!owner || !name) return null;
  const byName = db.find(
    "repositories",
    (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase()
  );
  if (byName && Number.isFinite(ghId) && byName.githubRepoId == null) {
    return db.update("repositories", (r) => r.id === byName.id, { githubRepoId: ghId }) ?? byName;
  }
  return byName;
}

const AUTH_STATUS: Record<Exclude<OidcResult, { ok: true }>["reason"], [number, string]> = {
  malformed: [401, "token_malformed"],
  unknown_key: [401, "token_unknown_key"],
  bad_signature: [401, "token_bad_signature"],
  expired: [401, "token_expired"],
  wrong_audience: [401, "token_wrong_audience"],
  wrong_issuer: [401, "token_wrong_issuer"],
  missing_claims: [401, "token_missing_claims"],
};

export function makeRunnerAuth(deps: { verify: (token: string) => Promise<OidcResult> } = { verify: verifyActionsToken }) {
  return async function runnerAuth(req: RunnerRequest, res: Response, next: NextFunction): Promise<void> {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return fail(res, 401, "missing_bearer_token");
    const result = await deps.verify(token);
    if (!result.ok) {
      const [status, error] = AUTH_STATUS[result.reason];
      return fail(res, status, error);
    }
    if (!ALLOWED_EVENTS.has(result.claims.event_name)) return fail(res, 403, "event_not_allowed");
    const repo = repoForClaims(result.claims);
    if (!repo) return fail(res, 403, "unknown_repository");
    const install = db.find("installations", (i) => i.id === repo.installationId) ?? null;
    req.runner = { claims: result.claims, repo, install, plan: planTierForRepo(repo) };
    next();
  };
}

const runnerAuth = makeRunnerAuth();

function parseResolveBody(body: unknown): ResolveRequest | null {
  const b = (body || {}) as Record<string, unknown>;
  const sha = typeof b.sha === "string" ? b.sha.trim() : "";
  const pr = Number(b.pr);
  if (!SHA_RE.test(sha) || !Number.isInteger(pr) || pr <= 0) return null;
  return {
    sha,
    pr,
    event: typeof b.event === "string" ? (b.event as ResolveRequest["event"]) : undefined,
    attempt: Number.isInteger(b.attempt) ? (b.attempt as number) : undefined,
    setup: b.setup && typeof b.setup === "object" ? (b.setup as ResolveRequest["setup"]) : undefined,
    actions: b.actions && typeof b.actions === "object" ? (b.actions as ResolveRequest["actions"]) : undefined,
    cliVersion: typeof b.cliVersion === "string" ? b.cliVersion.slice(0, 40) : undefined,
  };
}

function rememberSetup(repo: Repository, setup: ResolveRequest["setup"]): void {
  if (!setup || !Array.isArray(setup.frameworks)) return;
  db.update("repositories", (r) => r.id === repo.id, {
    verify: { onboarding: { state: "none" }, ...(repo.verify || {}), detected: setup },
  });
}

export async function resolveHandler(req: RunnerRequest, res: Response): Promise<void> {
  const runner = req.runner!;
  const body = parseResolveBody(req.body);
  if (!body) return fail(res, 400, "invalid_body", { detail: "sha (hex) and pr (positive int) are required" });
  const refPr = prNumberFromRef(runner.claims.ref);
  if (refPr != null && refPr !== body.pr) return fail(res, 403, "pr_mismatch");
  rememberSetup(runner.repo, body.setup);

  const review = db.find("prReviews", (r) => r.repoId === runner.repo.id && r.prNumber === body.pr);
  if (!review) {
    const out: ResolveResponse = { ok: true, status: "pending", runId: null, retryAfterMs: 5_000 };
    return void res.status(202).json(out);
  }
  const run = latestRunForReview(review.id, body.sha);
  if (!run) {
    const superseded = review.headSha.toLowerCase() !== body.sha.toLowerCase();
    const out: ResolveResponse = superseded
      ? { ok: true, status: "empty", runId: null, reason: "superseded" }
      : { ok: true, status: "pending", runId: null, retryAfterMs: 5_000 };
    return void res.status(superseded ? 200 : 202).json(out);
  }

  switch (run.status) {
    case "setup_pending": {
      const out: ResolveResponse = {
        ok: true,
        status: "setup",
        runId: run.id,
        ...(runner.repo.verify?.onboarding.prNumber ? { onboardingPr: runner.repo.verify.onboarding.prNumber } : {}),
      };
      return void res.json(out);
    }
    case "planning": {
      const out: ResolveResponse = { ok: true, status: "pending", runId: run.id, retryAfterMs: 3_000 };
      return void res.status(202).json(out);
    }
    case "skipped": {
      const out: ResolveResponse = { ok: true, status: "empty", runId: run.id, reason: run.skipReason ?? "no_criteria" };
      return void res.json(out);
    }
    case "awaiting_runner":
    case "running": {
      const plan = run.planId ? db.find("verifyPlans", (p) => p.id === run.planId) : null;
      if (!plan) return fail(res, 500, "plan_missing");
      const now = Date.now();
      updateRun(run.id, {
        status: "running",
        timings: { ...run.timings, resolvedAt: run.timings.resolvedAt ?? now },
        runnerMeta: {
          ...(run.runnerMeta || {}),
          actionsRunId: body.actions?.runId ?? runner.claims.run_id,
          runAttempt: runner.claims.run_attempt,
          runnerOs: body.actions?.runnerOs,
          jobUrl: body.actions?.jobUrl,
          cliVersion: body.cliVersion,
          workflowSha: runner.claims.sha,
          eventName: runner.claims.event_name,
        },
      });
      const out: ResolveResponse = { ok: true, status: "ready", runId: run.id, plan: runnerPlanFor(run, plan, runner.repo) };
      return void res.json(out);
    }
    default: {
      const out: ResolveResponse = { ok: true, status: "empty", runId: run.id, reason: "already_completed" };
      return void res.json(out);
    }
  }
}

function runForRunner(req: RunnerRequest, res: Response) {
  const run = db.find("verifyRuns", (r) => r.id === String(req.params.runId));
  if (!run || run.repoId !== req.runner!.repo.id) {
    fail(res, 404, "run_not_found");
    return null;
  }
  return run;
}

function parseSignFiles(body: unknown): ArtifactSignFile[] | null {
  const files = (body as { files?: unknown })?.files;
  if (!Array.isArray(files)) return null;
  return files.map((f) => {
    const o = (f || {}) as Record<string, unknown>;
    return {
      clientRef: String(o.clientRef ?? ""),
      kind: String(o.kind ?? "") as VerifyArtifactKind,
      path: String(o.path ?? "").slice(0, 500),
      bytes: Number(o.bytes),
      contentType: String(o.contentType ?? "application/octet-stream").slice(0, 100),
      testId: typeof o.testId === "string" ? o.testId : undefined,
      criterionIds: Array.isArray(o.criterionIds) ? o.criterionIds.map(String).slice(0, 50) : [],
      attempt: Number.isInteger(o.attempt) ? (o.attempt as number) : undefined,
      posterFor: typeof o.posterFor === "string" ? o.posterFor : undefined,
    };
  });
}

export async function artifactsHandler(req: RunnerRequest, res: Response): Promise<void> {
  const run = runForRunner(req, res);
  if (!run) return;
  if (run.status !== "running" && run.status !== "awaiting_runner") return fail(res, 409, "run_not_accepting_artifacts");
  const files = parseSignFiles(req.body);
  if (!files) return fail(res, 400, "invalid_body", { detail: "files[] is required" });

  const storage = artifactStorage();
  const out: ArtifactSignResponse = { ok: true, uploads: [], rejected: [] };
  if (!storage) {
    out.rejected = files.map((f) => ({ clientRef: f.clientRef, reason: "storage_unconfigured" }));
    return void res.json(out);
  }

  const existing = db.filter("verifyArtifacts", (a) => a.runId === run.id);
  let totalBytes = existing.reduce((s, a) => s + a.bytes, 0);
  let count = existing.length;
  const now = Date.now();
  const expiresAt = retentionExpiresAt(req.runner!.plan, now);
  const idByRef = new Map<string, string>();
  const rows: VerifyArtifact[] = [];

  for (const f of files) {
    if (!f.clientRef || !f.path || !Number.isFinite(f.bytes) || f.bytes < 0) {
      out.rejected.push({ clientRef: f.clientRef, reason: "invalid" });
      continue;
    }
    if (!ARTIFACT_KINDS.has(f.kind)) {
      out.rejected.push({ clientRef: f.clientRef, reason: "unsupported_kind" });
      continue;
    }
    if (f.bytes > UPLOAD_LIMITS.maxFileBytes) {
      out.rejected.push({ clientRef: f.clientRef, reason: "too_large" });
      continue;
    }
    if (count + 1 > UPLOAD_LIMITS.maxFiles || totalBytes + f.bytes > UPLOAD_LIMITS.maxTotalBytes) {
      out.rejected.push({ clientRef: f.clientRef, reason: "quota" });
      continue;
    }
    const id = uuid();
    idByRef.set(f.clientRef, id);
    rows.push({
      id,
      schemaVersion: 1,
      runId: run.id,
      repoId: run.repoId,
      testId: f.testId,
      criterionIds: f.criterionIds ?? [],
      kind: f.kind,
      path: f.path,
      storageKey: artifactKey(run.repoId, run.id, id, f.kind, f.contentType),
      bytes: f.bytes,
      contentType: f.contentType,
      posterArtifactId: null,
      attempt: f.attempt,
      state: "pending_upload",
      expiresAt,
      uploadedAt: null,
      expiredAt: null,
      createdAt: now,
    });
    count += 1;
    totalBytes += f.bytes;
  }
  // Link posters to their videos (both may be in this batch).
  for (const f of files) {
    if (f.kind !== "poster" || !f.posterFor) continue;
    const posterId = idByRef.get(f.clientRef);
    const videoId = idByRef.get(f.posterFor) ?? existing.find((a) => a.path === f.posterFor)?.id;
    if (!posterId || !videoId) continue;
    const video = rows.find((r) => r.id === videoId);
    if (video) video.posterArtifactId = posterId;
    else db.update("verifyArtifacts", (a) => a.id === videoId, { posterArtifactId: posterId });
  }

  const urlExpiresAt = now + config.artifacts.putUrlTtlSeconds * 1000;
  for (const row of rows) {
    const { url, headers } = await storage.signPut(row.storageKey, row.contentType, config.artifacts.putUrlTtlSeconds);
    db.insert("verifyArtifacts", row);
    const clientRef = [...idByRef.entries()].find(([, id]) => id === row.id)![0];
    out.uploads.push({ clientRef, artifactId: row.id, putUrl: url, headers, urlExpiresAt, retentionExpiresAt: expiresAt });
  }
  updateRun(run.id, { artifactBytes: totalBytes });
  res.json(out);
}

function parseResults(body: unknown, runId: string): RunnerResults | null {
  const b = (body || {}) as Record<string, any>;
  if (b.runId !== runId || typeof b.sha !== "string" || !Array.isArray(b.results)) return null;
  const results = b.results
    .filter((r: any) => r && typeof r === "object" && typeof r.testId === "string")
    .map((r: any) => ({
      id: String(r.id || uuid()),
      testId: String(r.testId),
      criterionIds: Array.isArray(r.criterionIds) ? r.criterionIds.map(String) : [],
      test: String(r.test || ""),
      runner: String(r.runner || "bundled"),
      level: String(r.level || "unit"),
      origin: r.origin === "existing" ? "existing" : "generated",
      status: ["pass", "fail", "flaky", "error", "skipped"].includes(r.status) ? r.status : "error",
      attempts: Array.isArray(r.attempts)
        ? r.attempts.map((a: any, i: number) => ({
            n: Number.isInteger(a?.n) ? a.n : i + 1,
            status: ["pass", "fail", "error"].includes(a?.status) ? a.status : "error",
            durationMs: Number(a?.durationMs) || 0,
            error: typeof a?.error === "string" ? a.error.slice(0, 20_000) : undefined,
            artifactIds: Array.isArray(a?.artifactIds) ? a.artifactIds.map(String) : [],
          }))
        : [],
      durationMs: Number(r.durationMs) || 0,
      error: typeof r.error === "string" ? r.error.slice(0, 20_000) : undefined,
      artifactIds: Array.isArray(r.artifactIds) ? r.artifactIds.map(String) : [],
    }));
  return {
    runId,
    sha: b.sha,
    planId: typeof b.planId === "string" ? b.planId : null,
    cliVersion: String(b.cliVersion || "").slice(0, 40),
    results,
    existingTestsTouchingDiff: Array.isArray(b.existingTestsTouchingDiff) ? b.existingTestsTouchingDiff.map(String).slice(0, 500) : [],
    stdoutArtifactId: typeof b.stdoutArtifactId === "string" ? b.stdoutArtifactId : undefined,
    setup: b.setup && typeof b.setup === "object" ? b.setup : undefined,
    doctor: b.doctor && typeof b.doctor === "object" ? b.doctor : null,
    timings: {
      startedAt: Number(b.timings?.startedAt) || 0,
      installFinishedAt: Number(b.timings?.installFinishedAt) || undefined,
      finishedAt: Number(b.timings?.finishedAt) || Date.now(),
    },
  } as RunnerResults;
}

export async function resultsHandler(req: RunnerRequest, res: Response): Promise<void> {
  const run = runForRunner(req, res);
  if (!run) return;
  // timed_out is accepted: a slow runner that finally reports beats a stale verdict.
  if (!["running", "awaiting_runner", "timed_out"].includes(run.status)) return fail(res, 409, "run_not_accepting_results");
  const payload = parseResults(req.body, run.id);
  if (!payload) return fail(res, 400, "invalid_body", { detail: "runId, sha and results[] are required" });
  if (payload.sha.toLowerCase() !== run.sha.toLowerCase()) return fail(res, 409, "sha_mismatch");
  rememberSetup(req.runner!.repo, payload.setup);

  const now = Date.now();
  const referenced = new Set<string>();
  for (const r of payload.results) {
    for (const id of r.artifactIds) referenced.add(id);
    for (const a of r.attempts) for (const id of a.artifactIds) referenced.add(id);
  }
  if (payload.stdoutArtifactId) referenced.add(payload.stdoutArtifactId);
  if (payload.doctor?.logArtifactId) referenced.add(payload.doctor.logArtifactId);
  for (const a of db.filter("verifyArtifacts", (a) => a.runId === run.id && a.state === "pending_upload")) {
    if (referenced.has(a.id) || a.kind === "poster") db.update("verifyArtifacts", (x) => x.id === a.id, { state: "uploaded", uploadedAt: now });
  }

  const row = db.insert("verifyResults", { id: uuid(), schemaVersion: 1, runId: run.id, payload, createdAt: now });
  updateRun(run.id, {
    status: "judging",
    resultsId: row.id,
    error: null,
    doctor: payload.doctor ?? null,
    timings: { ...run.timings, resultsAt: now },
    runnerMeta: { ...(run.runnerMeta || {}), cliVersion: payload.cliVersion || run.runnerMeta?.cliVersion },
  });
  enqueueVerifyJudge(run.id);
  const out: ResultsResponse = { ok: true, runId: run.id, status: "judging" };
  res.json(out);
}

// GET is shared: the runner (OIDC) or a signed-in install member (cookie).
async function readAuth(req: RunnerRequest, res: Response, next: NextFunction): Promise<void> {
  if (String(req.headers.authorization || "").startsWith("Bearer ")) return runnerAuth(req, res, next);
  const user = getSessionUser(req);
  if (!user) return fail(res, 401, "not_signed_in");
  const run = db.find("verifyRuns", (r) => r.id === String(req.params.runId));
  if (!run) return fail(res, 404, "run_not_found");
  const repo = db.find("repositories", (r) => r.id === run.repoId);
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  const allowed = !!install && (userInInstall(install, user.id) || installationsForUser(user.id).some((i) => i.id === install.id));
  if (!repo || !allowed) return fail(res, 404, "run_not_found");
  req.runner = undefined;
  (req as Request & { viewer?: { userId: string } }).viewer = { userId: user.id };
  next();
}

export async function getRunHandler(req: RunnerRequest, res: Response): Promise<void> {
  const run = db.find("verifyRuns", (r) => r.id === String(req.params.runId));
  if (!run || (req.runner && run.repoId !== req.runner.repo.id)) return fail(res, 404, "run_not_found");
  const view = await buildRunView(run, { includeUsage: !req.runner });
  res.json({ ok: true, ...view, apiVersion: 1, terminal: TERMINAL_STATUSES.has(run.status) });
}

export const v1 = Router();
v1.use(runnerLimiter);

// Dev-only artifact bytes (see verify/storage-local.ts). Registered before the
// JSON parser: bodies are raw files.
function localGuard(method: "PUT" | "GET", req: Request, res: Response): string | null {
  if (!localStoreEnabled()) {
    fail(res, 404, "not_found");
    return null;
  }
  const key = decodeURIComponent(String(req.params.key || ""));
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig || "");
  const full = localArtifactPath(key);
  if (!full || !verifyLocalSignature(method, key, exp, sig)) {
    fail(res, 403, "bad_signature");
    return null;
  }
  return full;
}
v1.put("/artifacts/local/:key", express.raw({ type: () => true, limit: UPLOAD_LIMITS.maxFileBytes }), async (req, res) => {
  const full = localGuard("PUT", req, res);
  if (!full) return;
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, req.body as Buffer);
  res.status(200).end();
});
v1.get("/artifacts/local/:key", async (req, res) => {
  const full = localGuard("GET", req, res);
  if (!full) return;
  try {
    const bytes = await readFile(full);
    const ext = path.extname(full).toLowerCase();
    const type = ext === ".webm" ? "video/webm" : ext === ".zip" ? "application/zip" : ext === ".png" ? "image/png" : ext === ".jpg" ? "image/jpeg" : "text/plain; charset=utf-8";
    res.setHeader("Content-Type", type);
    res.send(bytes);
  } catch {
    fail(res, 404, "not_found");
  }
});

v1.use(express.json({ limit: "8mb" }));
v1.post("/runs/resolve", runnerAuth, resolveHandler);
v1.post("/runs/:runId/artifacts", runnerAuth, artifactsHandler);
v1.post("/runs/:runId/results", runnerAuth, resultsHandler);
v1.get("/runs/:runId", readAuth, getRunHandler);
v1.get("/health", (_req, res) => {
  res.json({ ok: true, apiVersion: 1, verifyEnabled: effectiveWorkflow({ workflow: undefined }).stages.verify });
});
