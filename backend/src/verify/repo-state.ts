// repo.verify helpers shared by onboarding, the runner API, planning and setup status.
import { createHash } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import type { RepoVerifyState } from "../types.js";
import type { DevasignVerifyConfig } from "./contract.js";
import { BOOT_KEYS } from "./yml.js";

const EMPTY: RepoVerifyState = { onboarding: { state: "none" } };

/** Patch repo.verify against the row as it is now, never a copy read before an await. */
export function patchRepoVerify(repoId: string, fn: (cur: RepoVerifyState) => RepoVerifyState): RepoVerifyState | null {
  const row = db.find("repositories", (r) => r.id === repoId);
  if (!row) return null;
  const next = fn(row.verify ?? EMPTY);
  db.update("repositories", (r) => r.id === repoId, { verify: next });
  return next;
}

/** Where every "set up browser tests" link lands: the Workflow page with the setup panel open. */
export function setupFixUrl(repoId: string): string {
  return `${config.webOrigin.replace(/\/+$/, "")}/workflow?${new URLSearchParams({ repo: repoId, setup: "browser" })}`;
}

// Object keys sorted at every depth, so the same config always serializes the same way.
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** A stable fingerprint of the keys that boot the app; null when there is nothing to boot. */
export function bootHash(cfg: DevasignVerifyConfig | null | undefined): string | null {
  if (!cfg?.start || !cfg?.url) return null;
  const picked = BOOT_KEYS.filter((k) => cfg[k]).map((k) => [k, cfg[k]]);
  return createHash("sha256").update(stableJson(picked)).digest("hex").slice(0, 16);
}

export type BrowserTestsStatus = "disabled" | "not_configured" | "failing" | "runner_outdated" | "proven" | "unproven" | "boot_failed" | "unknown";

/** Whether the probe's own verdict is about the config the default branch runs today. */
function bootIsCurrent(v: RepoVerifyState): boolean {
  const boot = v.boot;
  if (!boot?.configHash || boot.configHash !== v.defaultYml?.bootHash) return false;
  // The hash was read at the setup PR's head; the probe must have booted that same commit.
  return !!boot.configSha && boot.configSha.toLowerCase() === boot.sha.toLowerCase();
}

/** A boot probe proves the setup only while the yml it booted is still the one on the default branch. */
function bootProven(v: RepoVerifyState, parsed: DevasignVerifyConfig | null): boolean {
  const boot = v.boot;
  if (!boot?.ok || !bootIsCurrent(v)) return false;
  // A boot that came up with a login script already ran that script; only a session check
  // that actually answered wrong (signedIn === false) contradicts it.
  return !parsed?.login?.script || boot.signedIn !== false;
}

export function browserTestsStatus(v: RepoVerifyState | null | undefined): { status: BrowserTestsStatus; missing: Array<"start" | "url"> } {
  const last = v?.lastBrowserless ?? null;
  // Boot failure and browser tests that decided nothing are both a failing setup; only the panel's wording differs.
  const failure = !last
    ? null
    : last.reason === "did_not_start" || last.reason === "browser_errored"
      ? { status: "failing" as const, at: last.at }
      : last.reason === "runner_outdated"
        ? { status: "runner_outdated" as const, at: last.at }
        : null;
  if (v?.defaultYml) {
    const parsed = v.defaultYml.parsed;
    if (parsed?.e2e === "never") return { status: "disabled", missing: [] };
    // Mirrors planPolicy: a Playwright config the runner found also tells it how to boot.
    const playwrightConfig = !!v.detected?.frameworks?.some((f) => f.name === "playwright" && !!f.configPath);
    const missing = (["start", "url"] as const).filter((k) => !parsed?.[k]);
    if (missing.length && !playwrightConfig) return { status: "not_configured", missing };
    // A run that failed after the probe outranks it: the probe only ever proved one commit.
    // So does an older one the probe cannot have fixed, because it booted that very config.
    const sameConfigAsFailure = !!last?.bootHash && !!v.boot?.configHash && last.bootHash === v.boot.configHash;
    if (failure && (!v.boot || failure.at >= v.boot.at || sameConfigAsFailure)) return { status: failure.status, missing: [] };
    if (bootProven(v, parsed)) return { status: "proven", missing: [] };
    if (failure) return { status: failure.status, missing: [] };
    // The probe ran this exact config and it did not come up: that is not "configured".
    if (v.boot && v.boot.ok === false && bootIsCurrent(v)) return { status: "boot_failed", missing: [] };
    return { status: "unproven", missing: [] };
  }
  // No default-branch snapshot yet: the last judged run is the only evidence.
  if (last?.reason === "not_configured") return { status: "not_configured", missing: [] };
  if (failure) return { status: failure.status, missing: [] };
  return { status: "unknown", missing: [] };
}
