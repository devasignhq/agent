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

// ---- "Re-check boot": proving a boot config without waiting for a setup PR ----

// The backend answers with codes, not prose; the panel owns its own wording.
const BOOT_CHECK_REASONS: Record<string, string> = {
  no_setup_pr: "DevAsign has not set this repo up yet — open the setup PR first",
  setup_pr_open: "The setup PR is still open — its own CI is what proves the config it proposes",
  not_dispatchable: "This repo's verify job shares a workflow with others, so it has no repository_dispatch trigger for DevAsign to use",
  requested: "DevAsign asked CI to boot the app — nothing has picked it up yet",
  pending: "A check is already running — its result lands here when CI finishes",
  cooldown: "A check was just asked for — try again in a minute",
  rate_limited: "This repo has used its boot checks for today — try again tomorrow",
  no_installation: "The DevAsign GitHub App is no longer installed on this repo",
  head_unreadable: "DevAsign could not read the latest commit on the default branch",
  dispatch_failed: "GitHub would not start the check — the workflow needs a repository_dispatch trigger",
};
export const BOOT_CHECK_ASK_FAILED = "Could not ask for the check — try again";

export function bootCheckReason(reason?: string): string {
  return (reason && BOOT_CHECK_REASONS[reason]) || "DevAsign cannot re-check this repo's boot right now";
}

/**
 * The answer to a click: the request can be accepted and still dispatch nothing, and even an
 * accepted dispatch only means GitHub took it — no run exists until one picks it up.
 */
export function bootCheckStarted(res: { dispatched: boolean; reason?: string }): string {
  return res.dispatched ? "DevAsign asked CI to boot the app — the result lands here when it finishes" : `Could not start the check: ${bootCheckReason(res.reason)}`;
}

export type BootEvidence = {
  /** The whole line: what the probe found (dropped when the row above already said it) and where it ran. */
  line: string;
  tone: "ok" | "warn";
  links: Array<{ label: string; href: string }>;
};

export type BootCheckView = {
  evidence: BootEvidence | null;
  /** null when there is nothing to click; `note` then says why not. */
  button: { label: string } | null;
  note: string | null;
};

export type BootCheckSetup = Pick<VerifySetup, "browserTests" | "devasignYml" | "boot" | "probeUnavailable" | "bootCheck" | "onboarding">;

/** What a probe that DID boot the app found: a sign-in is claimed only when it happened. */
export function bootOkText(boot: NonNullable<VerifySetup["boot"]>): string {
  if (boot.signedIn === true) return "The app came up in CI and DevAsign signed in";
  if (boot.signedIn === false) return "The app came up in CI, but DevAsign did not sign in";
  return "The app came up in CI";
}

/** A re-check runs on the default branch, so it has a sha to name but no PR of its own. */
function bootSource(boot: NonNullable<VerifySetup["boot"]>): string | null {
  if (boot.prNumber > 0) return `PR #${boot.prNumber}`;
  return boot.sha ? boot.sha.slice(0, 7) : null;
}

function bootEvidence(setup: BootCheckSetup, now: number): BootEvidence | null {
  const boot = setup.boot;
  if (!boot) {
    const runner = setup.probeUnavailable;
    if (!runner) return null;
    const line = runner.cliVersion
      ? `The runner in CI (@devasign/verify ${runner.cliVersion}) is too old to check the boot — update it`
      : "The runner in CI is too old to check the boot — update @devasign/verify";
    return { line, tone: "warn", links: [] };
  }
  const row = browserTestsRow(setup);
  const text = boot.ok ? bootOkText(boot) : bootFailureText(boot);
  // The row above already made this claim; repeating it reads like two separate checks.
  const said = text === row.text || (row.status === "proven" && boot.signedIn === null);
  const where = bootSource(boot);
  const line = said ? (where ? `Checked on ${where}` : null) : where ? `${text} · checked on ${where}` : text;
  if (!line) return null;
  const expired = !!boot.urlExpiresAt && boot.urlExpiresAt <= now;
  const links = expired
    ? []
    : ([["boot log", boot.logUrl], ["screenshot", boot.screenshotUrl]] as const).flatMap(([label, href]) => (href ? [{ label, href }] : []));
  return { line, tone: boot.ok && boot.signedIn !== false ? "ok" : "warn", links };
}

// The refusals the backend derives from the request history itself (the probe rows and
// onboarding.bootCheck), so the only ones a failure recorded against that request outranks.
const REASONS_ABOUT_LAST_REQUEST = new Set(["requested", "pending", "cooldown", "rate_limited"]);

/** The "Re-check boot" control: what the last probe found, and whether another check can be asked for. */
export function bootCheckView(setup: BootCheckSetup, now: number = Date.now()): BootCheckView {
  const evidence = bootEvidence(setup, now);
  const offer = setup.bootCheck;
  if (!offer) return { evidence, button: null, note: null };
  const asked = setup.onboarding?.bootCheck ?? null;
  // Only the request's OWN probe answers it: another probe's verdict landing in between is
  // not a reply, and silently reading as one would hide a check that never ran.
  const answered = !!setup.boot && (setup.boot.probeId ? setup.boot.probeId === asked?.probeId : setup.boot.at >= (asked?.at ?? 0));
  // What the backend recorded against a request its own probe has not answered; once that
  // probe reports, the verdict above is the story and the recorded failure is stale.
  const failed = !asked || answered ? null : asked.error ? `The last check did not run: ${asked.error}` : !asked.dispatched ? "The last check did not reach CI" : null;
  // Whether a check is in flight is the backend's call (it holds the probe row), never a timer
  // here — but a request CI already refused must not be reported as one that is still going.
  if (!offer.available) {
    const generic = bootCheckReason(offer.reason);
    return { evidence, button: null, note: failed && REASONS_ABOUT_LAST_REQUEST.has(offer.reason ?? "") ? failed : generic };
  }
  const note = failed ?? (asked && !answered ? "The last check never reported back" : null);
  return { evidence, button: { label: setup.boot ? "Re-check boot" : "Check boot now" }, note };
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
