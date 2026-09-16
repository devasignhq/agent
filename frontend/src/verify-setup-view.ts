// Pure view logic for the Verification popover in the Workflow header (the
// "Browser tests" row and its ?setup=browser deep link). React-free for node --test.
import type { BrowserTestsStatus, VerifySetup } from "./api.ts";

export const VERIFY_YML_REFERENCE = "https://github.com/devasignhq/verify-action#readme";

export function uiCriteriaCount(count: number): string {
  return count === 1 ? "1 UI criterion" : `${count} UI criteria`;
}

export type BrowserTestsRow = {
  status: BrowserTestsStatus;
  tone: "ok" | "warn" | "mute";
  text: string;
  last: string | null;
  // What CI will actually run, once the default branch says how to boot the app.
  boot: { start: string; url: string; servers: string[] } | null;
};

// Old backends send no browserTests; the planner's yml snapshot is the best guess then.
function legacyStatus(yml: VerifySetup["devasignYml"]): { status: BrowserTestsStatus; missing: Array<"start" | "url"> } {
  if (!yml) return { status: "unknown", missing: [] };
  if (yml.e2e === "never") return { status: "disabled", missing: [] };
  const missing = (["start", "url"] as const).filter((k) => !yml[k]);
  return { status: missing.length ? "not_configured" : "unproven", missing };
}

/** What a probe that failed says went wrong. Two stages mean the app was up, so they do not blame the boot. */
export function bootFailureText(boot: NonNullable<VerifySetup["boot"]>): string {
  const where = boot.stage === "servers" && boot.failedServer ? `the ${boot.failedServer} server` : null;
  if (boot.stage === "login") return "The app came up in CI, but DevAsign could not sign in";
  if (boot.stage === "page") return "The app came up in CI, but its page did not load";
  if (boot.stage === "browsers") return "DevAsign could not install its browser in CI — the app itself came up";
  return where ? `The app did not start in CI — ${where} never came up` : "The app did not start in CI";
}

export function browserTestsRow(setup: Pick<VerifySetup, "browserTests" | "devasignYml" | "boot">): BrowserTestsRow {
  const bt = setup.browserTests;
  const { status, missing } = bt ? { status: bt.status, missing: bt.missing ?? [] } : legacyStatus(setup.devasignYml);
  const last = bt?.lastBrowserless ?? null;
  let text: string;
  let tone: BrowserTestsRow["tone"] = "warn";
  if (status === "not_configured") {
    text = "Not set up — add verify.start and verify.url to .devasign.yml";
    if (missing.length) text += ` (missing: ${missing.map((k) => `verify.${k}`).join(", ")})`;
  } else if (status === "failing") {
    // "failing" covers both an app that never came up and browser tests that ran and could not
    // decide; only a run that said so blames the boot, since that is the stronger claim.
    const onPr = last?.prNumber ? ` on PR #${last.prNumber}` : "";
    text = last?.reason === "did_not_start" ? `The app did not start in CI${onPr}` : `Browser tests could not run${onPr}`;
  } else if (status === "runner_outdated") {
    text = "The runner in CI is too old for verify.servers or verify.login — update @devasign/verify";
  } else if (status === "proven") {
    // The setup PR's own CI booted this config; say where it came up, not just that it is configured.
    const url = bt?.defaultYml?.url;
    text = url ? `Working — the app came up at ${url} in CI` : "Working — the app came up in CI";
    tone = "ok";
  } else if (status === "boot_failed") {
    // The setup PR's own CI booted this exact config and it did not come up: never a green row.
    text = setup.boot ? bootFailureText(setup.boot) : "The app did not start in CI";
  } else if (status === "unproven") {
    text = "Configured";
    tone = "ok";
  } else if (status === "disabled") {
    text = "Off (e2e: never)";
    tone = "mute";
  } else {
    text = "Not checked yet";
    tone = "mute";
  }
  const showLast = status !== "disabled" && !!last && last.count > 0;
  const yml = bt?.defaultYml ?? null;
  const boot =
    status !== "not_configured" && status !== "disabled" && yml?.start && yml?.url
      ? { start: yml.start, url: yml.url, servers: (yml.servers ?? []).map((s) => s.name).filter(Boolean) }
      : null;
  return { status, tone, text, last: showLast ? `PR #${last.prNumber}: ${uiCriteriaCount(last.count)} checked without a browser` : null, boot };
}

/** A fix link names its repo; the panel opens only for that repo (or when none is named). */
export function opensBrowserSetup(params: URLSearchParams, repoId: string): boolean {
  if (params.get("setup") !== "browser") return false;
  const want = params.get("repo");
  return !want || want === repoId;
}

export function withoutBrowserSetup(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("setup");
  return next;
}
