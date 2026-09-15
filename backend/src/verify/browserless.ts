// Which UI criteria a judged run decided without a browser. Shared by the report (the PR
// note) and the judge (repo.verify.lastBrowserless), so both count the same criteria.
import type { BrowserlessReason, Criterion, CriterionVerdict, VerifyPlan } from "../types.js";

export type BrowserlessSummary = { count: number; criterionIds: string[]; reason: BrowserlessReason; fixUrl: string };

export function browserlessSummary(args: {
  criteria: Criterion[];
  verdicts: CriterionVerdict[];
  plan: Pick<VerifyPlan, "browser"> | null | undefined;
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
  return { count: ids.length, criterionIds: ids, reason: b.allowed ? "did_not_start" : "not_configured", fixUrl: b.fixUrl };
}
