// The setup PR's own CI boots the proposed config and reports back. Anyone who can open a PR
// can influence that report, so it is whitelisted here and the PR comment is composed from the
// repo's own .devasign.yml plus fixed per-stage text — never from a runner-supplied string.
import { db } from "../db.js";
import { postPRCommentReturningId, pullRequestHeadSha, readFileAtRefStrict, updatePRCommentResult, type CommentUpdate } from "../github/app.js";
import { pushNotification } from "../notifications.js";
import type { Installation, Repository, RepoVerifyState } from "../types.js";
import type { BootReport, BootStage, DevasignVerifyConfig } from "./contract.js";
import { normalizeDoctor } from "./doctor-normalize.js";
import { DEVASIGN_YML_PATH } from "./onboarding/generate.js";
import { bootHash, patchRepoVerify, setupFixUrl } from "./repo-state.js";
import { artifactStorage } from "./storage.js";
import { parseDevasignVerify } from "./yml.js";

const STAGES: Record<BootStage, true> = { config: true, install: true, servers: true, start: true, login: true, browsers: true, page: true, done: true };
const CORS = new Set(["ok", "missing", "mismatch"]);
// yml.ts's own server-name rule: a name that could never appear in a verify block is not one.
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ARTIFACT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SHA = /^[0-9a-fA-F]{7,64}$/;
const CLI_VERSION = /^[\w.+-]{1,40}$/;
// A boot the runner reports as taking longer than this was not measured, it was made up.
export const BOOT_LIMITS = { servers: 12, durationMs: 24 * 60 * 60 * 1000, exitCode: 1_000_000 };

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const millis = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), BOOT_LIMITS.durationMs) : undefined;

const httpStatus = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599 ? v : undefined;

const exitCode = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= BOOT_LIMITS.exitCode ? v : null;

const artifactId = (v: unknown): string | undefined => (typeof v === "string" && ARTIFACT_ID.test(v) ? v : undefined);

/** Whitelist + caps + finite numbers + normalizeDoctor. Null when the payload cannot be trusted at all. */
export function normalizeBootReport(raw: unknown): BootReport | null {
  const o = record(raw);
  if (!o) return null;
  if (typeof o.stage !== "string" || !Object.hasOwn(STAGES, o.stage)) return null;
  if (typeof o.sha !== "string" || !SHA.test(o.sha)) return null;
  const login = record(o.login);
  if (login && login.cors !== undefined && !(typeof login.cors === "string" && CORS.has(login.cors))) return null;

  const out: BootReport = {
    sha: o.sha,
    ok: o.ok === true,
    stage: o.stage as BootStage,
    durationMs: millis(o.durationMs) ?? 0,
    cliVersion: typeof o.cliVersion === "string" && CLI_VERSION.test(o.cliVersion) ? o.cliVersion : "",
    servers: [],
  };
  if (typeof o.failedServer === "string" && SERVER_NAME.test(o.failedServer)) out.failedServer = o.failedServer;
  if (Array.isArray(o.servers)) {
    out.servers = o.servers
      .map(record)
      .filter((s): s is Record<string, unknown> => !!s && typeof s.name === "string" && SERVER_NAME.test(s.name))
      .slice(0, BOOT_LIMITS.servers)
      .map((s) => {
        const readyMs = millis(s.readyMs);
        return {
          name: s.name as string,
          ok: s.ok === true,
          ...(readyMs === undefined ? {} : { readyMs }),
          ...(s.exitCode === undefined ? {} : { exitCode: exitCode(s.exitCode) }),
        };
      });
  }
  if (login) {
    const checkStatus = httpStatus(login.checkStatus);
    out.login = {
      ran: login.ran === true,
      checked: login.checked === true,
      ok: login.ok === true,
      ...(checkStatus === undefined ? {} : { checkStatus }),
      ...(login.cors === undefined ? {} : { cors: login.cors as "ok" | "missing" | "mismatch" }),
    };
  }
  const page = record(o.page);
  if (page) out.page = { status: httpStatus(page.status) ?? null };
  if (o.diagnosis != null) {
    const diagnosis = normalizeDoctor(o.diagnosis);
    if (diagnosis) out.diagnosis = diagnosis;
  }
  const log = artifactId(o.logArtifactId);
  const shot = artifactId(o.screenshotArtifactId);
  if (log) out.logArtifactId = log;
  if (shot) out.screenshotArtifactId = shot;
  return out;
}

// ---- Settle: repo state, one PR comment, one notification -------------------

export const BOOT_COMMENT_MARKER = "<!-- devasign:boot-check -->";
export const BOOT_ARTIFACT_TTL_SECONDS = 300;

// The url is repo-authored text: it goes in a code span, and only if it is a plain URL.
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9\-._~/]*)?$/;

export type SettleDeps = {
  read?: (...a: any[]) => Promise<string | null>;
  prHeadSha?: (...a: any[]) => Promise<string | null>;
  postComment?: (...a: any[]) => Promise<number | null>;
  updateComment?: (...a: any[]) => Promise<CommentUpdate>;
};

type Deps = {
  read: (install: Installation, repo: Repository, path: string, ref: string) => Promise<string | null>;
  prHeadSha: (install: Installation, repo: Repository, prNumber: number) => Promise<string | null>;
  postComment: (install: Installation, repo: Repository, prNumber: number, body: string) => Promise<number | null>;
  updateComment: (install: Installation, repo: Repository, commentId: number, body: string) => Promise<CommentUpdate>;
};

const defaults: Deps = {
  read: (install, repo, path, ref) => readFileAtRefStrict(install.installationId, repo.owner, repo.name, path, ref),
  prHeadSha: (install, repo, prNumber) => pullRequestHeadSha(install.installationId, repo.owner, repo.name, prNumber),
  postComment: (install, repo, prNumber, body) => postPRCommentReturningId(install.installationId, repo.owner, repo.name, prNumber, body),
  updateComment: (install, repo, commentId, body) => updatePRCommentResult(install.installationId, repo.owner, repo.name, commentId, body),
};

/** A url from the repo's own yml, rendered so nothing in it can be markdown. */
function urlSpan(url: string | undefined): string {
  return url && SAFE_URL.test(url) ? ` at \`${url}\`` : "";
}

/**
 * Did the app come up? Only a report that agrees with itself says so: `ok` alone is a
 * runner-set boolean, and one that stopped at `install` or left a server dead did not boot.
 */
function cameUp(report: BootReport, cfg: DevasignVerifyConfig | null): boolean {
  if (!report.ok || report.stage !== "done") return false;
  if (report.servers.some((s) => !s.ok)) return false;
  return !cfg?.login?.script || report.login?.ran === true;
}

/** null when the yml signs nothing in, or when nothing checked the session it got. */
function signedInFrom(report: BootReport, cfg: DevasignVerifyConfig | null): boolean | null {
  if (!cfg?.login?.script || !cfg.login.check) return null;
  if (!report.login?.ran || !report.login.checked) return null;
  return report.login.ok === true;
}

/** What the comment says about the session, or nothing at all when the yml signs nobody in. */
function sessionClause(report: BootReport, cfg: DevasignVerifyConfig | null): string | null {
  if (!cfg?.login?.script) return null;
  const signedIn = signedInFrom(report, cfg);
  if (signedIn === null) return "session not checked";
  const status = report.login?.checkStatus;
  return signedIn ? `signed in${status ? ` (check ${status})` : ""}` : "the session check failed";
}

function failureLabel(report: BootReport, cfg: DevasignVerifyConfig | null): string {
  if (report.stage !== "servers") return report.stage;
  const named = report.failedServer && (cfg?.servers ?? []).some((s) => s.name === report.failedServer);
  return named ? `servers/${report.failedServer}` : "servers";
}

/** The failure sentence. Two stages are only ever reached with the app already up, so they do not blame the boot. */
function failureText(report: BootReport, cfg: DevasignVerifyConfig | null): string {
  if (report.stage === "login") {
    const status = cfg?.login?.check && report.login?.checked ? report.login.checkStatus : undefined;
    return report.login?.checked ? `Came up, but the session check failed${status ? ` (check ${status})` : ""}` : "Came up, but the login script did not sign in";
  }
  if (report.stage === "page") return `Came up, but the page answered ${report.page?.status ?? "nothing"}`;
  if (report.stage === "browsers") return "Came up — DevAsign could not install its own browser, so the page was not loaded";
  return report.stage === "done" ? "Could not start" : `Could not start at ${failureLabel(report, cfg)}`;
}

/** The comment sentence, composed from the setup PR's own yml and fixed text. `plain` has no link. */
export function bootCommentText(report: BootReport, cfg: DevasignVerifyConfig | null, repoId: string): { markdown: string; plain: string } {
  if (cameUp(report, cfg)) {
    const took = report.durationMs >= 1000 ? ` in ${Math.round(report.durationMs / 1000)}s` : "";
    const session = sessionClause(report, cfg);
    const line = `Came up${urlSpan(cfg?.url)}${took}${session ? ` — ${session}` : ""}`;
    return { markdown: line, plain: line.replace(/`/g, "") };
  }
  const plain = failureText(report, cfg);
  return { markdown: `${plain} — [log and setup](${setupFixUrl(repoId)})`, plain };
}

// One repo settles one probe at a time, so two reports cannot interleave their comment upsert.
const chains = new Map<string, Promise<void>>();

/** Writes repo.verify.boot, upserts the PR comment, notifies. Serialized per repo. */
export async function settleBootProbe(probeId: string, deps: SettleDeps = {}): Promise<void> {
  const probe = db.find("bootProbes", (p) => p.id === probeId);
  if (!probe?.report) return;
  const key = probe.repoId;
  const run = (chains.get(key) ?? Promise.resolve()).then(() => settleOne(probeId, deps));
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** A report only replaces what is stored when it is about a later probe (or the same one again). */
export function supersedesBoot(cur: RepoVerifyState["boot"] | undefined, next: NonNullable<RepoVerifyState["boot"]>): boolean {
  if (!cur) return true;
  if (cur.probeId === next.probeId) return true;
  const a = cur.offeredAt ?? 0;
  const b = next.offeredAt ?? 0;
  return b > a || (b === a && next.at >= cur.at);
}

async function settleOne(probeId: string, deps: SettleDeps): Promise<void> {
  const d: Deps = { ...defaults, ...(deps as Partial<Deps>) };
  const probe = db.find("bootProbes", (p) => p.id === probeId);
  const report = probe?.report;
  if (!probe || !report) return;
  const repo = db.find("repositories", (r) => r.id === probe.repoId);
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  if (!repo || !install) return;

  // The config the boot is credited to is read at the sha the App picked — the setup PR's
  // own head — never at the sha the runner named. A probe of any other commit proves nothing.
  const headSha = await d.prHeadSha(install, repo, probe.prNumber);
  const onPrHead = !!headSha && headSha.toLowerCase() === probe.sha.toLowerCase();
  const cfg = onPrHead ? parseDevasignVerify(await d.read(install, repo, DEVASIGN_YML_PATH, headSha!)) : null;
  if (!onPrHead) {
    console.warn(`[verify] boot probe ${probe.id} booted ${probe.sha}, not ${repo.owner}/${repo.name}#${probe.prNumber}'s head (${headSha ?? "unreadable"})`);
  }

  // DevAsign's own browser install failing says nothing about the repo's config, so it
  // records no verdict — only the comment explains it.
  if (report.stage !== "browsers") {
    const boot: NonNullable<RepoVerifyState["boot"]> = {
      ok: cameUp(report, cfg),
      configHash: bootHash(cfg) ?? "",
      configSha: onPrHead ? headSha : null,
      prNumber: probe.prNumber,
      sha: probe.sha,
      at: probe.reportedAt ?? Date.now(),
      offeredAt: probe.offeredAt,
      stage: report.stage,
      ...(report.failedServer ? { failedServer: report.failedServer } : {}),
      signedIn: signedInFrom(report, cfg),
      probeId: probe.id,
      ...(report.logArtifactId ? { logArtifactId: report.logArtifactId } : {}),
      ...(report.screenshotArtifactId ? { screenshotArtifactId: report.screenshotArtifactId } : {}),
    };
    const stale = !supersedesBoot(db.find("repositories", (r) => r.id === repo.id)?.verify?.boot ?? undefined, boot);
    if (stale) {
      console.warn(`[verify] boot probe ${probe.id} reported after a newer probe on ${repo.owner}/${repo.name}; ignored`);
      return;
    }
    patchRepoVerify(repo.id, (cur) => (supersedesBoot(cur.boot ?? undefined, boot) ? { ...cur, boot } : cur));
  }

  const { markdown, plain } = bootCommentText(report, cfg, repo.id);
  const body = `${BOOT_COMMENT_MARKER}\n${markdown}`;
  // Keyed by comment id alone, GitHub would happily edit a closed PR's comment: only reuse
  // the handle when it belongs to the PR this probe ran on.
  const stored = db.find("repositories", (r) => r.id === repo.id)?.verify?.onboarding?.bootComment ?? null;
  const mine = stored && stored.prNumber === probe.prNumber ? stored.commentId : null;
  let commentId: number | null = null;
  if (mine !== null) {
    const outcome = await d.updateComment(install, repo, mine, body);
    // Only a comment that is really gone is re-posted; a 502 keeps the handle and posts nothing,
    // or the PR ends up with two boot comments contradicting each other.
    if (outcome !== "gone") {
      if (outcome === "failed") console.warn(`[verify] boot check comment ${mine} could not be edited on ${repo.owner}/${repo.name}; keeping it`);
      commentId = mine;
    }
  }
  if (commentId === null) commentId = await d.postComment(install, repo, probe.prNumber, body);
  // A post that failed returns null: never write that over a comment id that still works.
  if (commentId !== null) {
    patchRepoVerify(repo.id, (cur) => ({ ...cur, onboarding: { ...cur.onboarding, bootComment: { prNumber: probe.prNumber, commentId } } }));
  }

  const prUrl = db.find("repositories", (r) => r.id === repo.id)?.verify?.onboarding?.prUrl;
  pushNotification(install.userId, "system", `Boot check on ${repo.owner}/${repo.name}`, `PR #${probe.prNumber}: ${plain}`, { ...(prUrl ? { link: prUrl } : {}) });
}

/** Short-lived GET URLs for what the probe uploaded; the log can hold the app's own output. */
export async function signBootArtifacts(
  repoId: string,
  boot: RepoVerifyState["boot"]
): Promise<{ logUrl: string | null; screenshotUrl: string | null; urlExpiresAt: number | null }> {
  const none = { logUrl: null, screenshotUrl: null, urlExpiresAt: null };
  const storage = boot ? artifactStorage() : null;
  if (!boot || !storage) return none;
  const now = Date.now();
  const sign = async (id: string | undefined): Promise<string | null> => {
    const row = id ? db.find("verifyArtifacts", (a) => a.id === id && a.repoId === repoId) : null;
    if (!row || row.state !== "uploaded" || row.expiresAt <= now) return null;
    try {
      return await storage.signGet(row.storageKey, BOOT_ARTIFACT_TTL_SECONDS);
    } catch (err) {
      console.warn(`[verify] signGet failed for boot artifact ${id}:`, err);
      return null;
    }
  };
  const [logUrl, screenshotUrl] = await Promise.all([sign(boot.logArtifactId), sign(boot.screenshotArtifactId)]);
  return { logUrl, screenshotUrl, urlExpiresAt: logUrl || screenshotUrl ? now + BOOT_ARTIFACT_TTL_SECONDS * 1000 : null };
}
