// Which UI criteria a judged run decided without a browser. Shared by the report (the PR
// note) and the judge (repo.verify.lastBrowserless), so both count the same criteria.
import type { BrowserlessReason, Criterion, CriterionVerdict, VerifyPlan, VerifyRun } from "../types.js";
import type { DoctorDiagnosis, RunnerResult } from "./contract.js";

// "paused": DevAsign's managed-boot kill switch held the browser tests back, so there is nothing to fix and no link.
export type BrowserlessSummary = { count: number; criterionIds: string[]; reason: BrowserlessReason | "paused"; fixUrl: string };

export type E2eWithheld = NonNullable<NonNullable<VerifyRun["runnerMeta"]>["e2eWithheld"]>;

const NEVER_CAME_UP: ReadonlySet<DoctorDiagnosis["code"]> = new Set(["no_start_command", "app_not_ready", "login_failed"]);
// Checkout through login is the app coming up, and a failure there stops it. Only these two stages
// are reached with the app already running (doctor-normalize lands an unknown stage on "tests").
const APP_WAS_UP: ReadonlySet<DoctorDiagnosis["stage"]> = new Set(["tests", "browsers"]);

/** The app never came up — as opposed to browser tests that ran against a live app and decided nothing. */
export function appNeverStarted(doctor: DoctorDiagnosis | null | undefined): boolean {
  return !!doctor && (!APP_WAS_UP.has(doctor.stage) || NEVER_CAME_UP.has(doctor.code));
}

// Criteria this run neither planned nor ran: a feedback re-run copies their verdict, browser stamp
// and all, from the run before it, so this run's doctor says nothing about them.
export function inheritedCriteria(args: {
  inheritFromRunId?: string | null;
  candidates: Iterable<string>;
  plan: Pick<VerifyPlan, "tests" | "unverifiable"> | null | undefined;
  results: Array<Pick<RunnerResult, "criterionIds">> | null | undefined;
}): Set<string> {
  if (!args.inheritFromRunId) return new Set();
  const covered = new Set([
    ...(args.results ?? []).flatMap((r) => r.criterionIds),
    ...(args.plan?.tests ?? []).flatMap((t) => t.criterionIds),
    ...(args.plan?.unverifiable ?? []).map((u) => u.criterionId),
  ]);
  return new Set([...args.candidates].filter((id) => !covered.has(id)));
}

export function browserlessSummary(args: {
  criteria: Criterion[];
  verdicts: CriterionVerdict[];
  plan: Pick<VerifyPlan, "browser"> | null | undefined;
  withheld?: E2eWithheld | null;
  doctor?: DoctorDiagnosis | null;
  inherited?: Iterable<string> | null;
}): BrowserlessSummary | null {
  const b = args.plan?.browser;
  // Old plans carry no policy, and `e2e: never` asked for no browser.
  if (!b || b.policy === "never") return null;
  const ui = new Set(args.criteria.filter((c) => (c.kind ?? "code") === "ui").map((c) => c.id));
  // A verdict carried over from an earlier run was not checked here, and that run's cause still stands on its row.
  const from = new Set(args.inherited ?? []);
  const uiVerdicts = args.verdicts.filter((v) => ui.has(v.criterionId) && !from.has(v.criterionId));
  // With boot config the planner may still pick a cheaper level, so only a browser that could not run counts,
  // including a fallback `e2e: always` then refused; without it, every UI criterion still given a pass or fail.
  const ids = (b.allowed ? uiVerdicts.filter((v) => v.browser === "fallback") : uiVerdicts.filter((v) => v.verdict !== "unverifiable")).map((v) => v.criterionId);
  if (!ids.length) return null;
  if (b.allowed && args.withheld === "managed_boot_off") return { count: ids.length, criterionIds: ids, reason: "paused", fixUrl: "" };
  // With the app up, the browser tests ran and none of them decided: that is not the boot's fault.
  const reason: BrowserlessReason = !b.allowed
    ? "not_configured"
    : args.withheld === "runner_outdated"
      ? "runner_outdated"
      : appNeverStarted(args.doctor)
        ? "did_not_start"
        : "browser_errored";
  return { count: ids.length, criterionIds: ids, reason, fixUrl: b.fixUrl };
}
