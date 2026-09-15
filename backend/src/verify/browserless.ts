// Which UI criteria a judged run decided without a browser. Shared by the report (the PR
// note) and the judge (repo.verify.lastBrowserless), so both count the same criteria.
import type { BrowserlessReason, Criterion, CriterionVerdict, VerifyPlan, VerifyRun } from "../types.js";
import type { DoctorDiagnosis } from "./contract.js";

// "paused": DevAsign's managed-boot kill switch held the browser tests back, so there is nothing to fix and no link.
export type BrowserlessSummary = { count: number; criterionIds: string[]; reason: BrowserlessReason | "paused"; fixUrl: string };

export type E2eWithheld = NonNullable<NonNullable<VerifyRun["runnerMeta"]>["e2eWithheld"]>;

const NEVER_CAME_UP: ReadonlySet<DoctorDiagnosis["code"]> = new Set(["no_start_command", "app_not_ready", "login_failed"]);

/** The app never came up — as opposed to browser tests that ran against a live app and decided nothing. */
export function appNeverStarted(doctor: DoctorDiagnosis | null | undefined): boolean {
  return !!doctor && (doctor.stage === "start" || doctor.stage === "login" || NEVER_CAME_UP.has(doctor.code));
}

export function browserlessSummary(args: {
  criteria: Criterion[];
  verdicts: CriterionVerdict[];
  plan: Pick<VerifyPlan, "browser"> | null | undefined;
  withheld?: E2eWithheld | null;
  doctor?: DoctorDiagnosis | null;
}): BrowserlessSummary | null {
  const b = args.plan?.browser;
  // Old plans carry no policy, and `e2e: never` asked for no browser.
  if (!b || b.policy === "never") return null;
  const ui = new Set(args.criteria.filter((c) => (c.kind ?? "code") === "ui").map((c) => c.id));
  const uiVerdicts = args.verdicts.filter((v) => ui.has(v.criterionId));
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
