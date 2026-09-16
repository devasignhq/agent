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
};

// Old backends send no browserTests; the planner's yml snapshot is the best guess then.
function legacyStatus(yml: VerifySetup["devasignYml"]): { status: BrowserTestsStatus; missing: Array<"start" | "url"> } {
  if (!yml) return { status: "unknown", missing: [] };
  if (yml.e2e === "never") return { status: "disabled", missing: [] };
  const missing = (["start", "url"] as const).filter((k) => !yml[k]);
  return { status: missing.length ? "not_configured" : "unproven", missing };
}

export function browserTestsRow(setup: Pick<VerifySetup, "browserTests" | "devasignYml">): BrowserTestsRow {
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
  return { status, tone, text, last: showLast ? `PR #${last.prNumber}: ${uiCriteriaCount(last.count)} checked without a browser` : null };
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
