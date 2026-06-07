// Offline tests for the per-repo workflow helpers. No network/db:
//   node --import tsx/esm --test src/review/workflow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_DEFAULTS,
  advancedChanged,
  effectiveWorkflow,
  normalizeWorkflow,
} from "./workflow.js";

test("effectiveWorkflow with no stored workflow reproduces prior behavior", () => {
  const wf = effectiveWorkflow({ workflow: undefined });
  // Every optional stage runs, and the trigger/verdict policy matches what the
  // pipeline did before workflows existed.
  assert.deepEqual(wf.stages, { holistic: true, docs: true, deferrals: true });
  assert.deepEqual(wf.trigger, { onSynchronize: true, skipDrafts: false, skipBots: false });
  assert.equal(wf.verdict.blocking, true);
  assert.deepEqual(wf, WORKFLOW_DEFAULTS);
});

test("effectiveWorkflow merges a partial stored workflow over the defaults", () => {
  const wf = effectiveWorkflow({
    workflow: { version: 1, stages: { holistic: false } } as any,
  });
  assert.equal(wf.stages.holistic, false); // overridden
  assert.equal(wf.stages.docs, true); // filled from defaults
  assert.equal(wf.stages.deferrals, true); // filled from defaults
  assert.equal(wf.trigger.onSynchronize, true); // whole sub-object defaulted
  assert.equal(wf.verdict.blocking, true);
});

test("normalizeWorkflow coerces non-booleans to defaults and pins version", () => {
  const wf = normalizeWorkflow({
    version: 99,
    trigger: { skipDrafts: "yes", skipBots: true },
    stages: { holistic: 0, docs: false },
    verdict: { blocking: null },
    bogus: "dropped",
  });
  assert.equal(wf.version, 1);
  assert.equal(wf.trigger.skipDrafts, false); // "yes" -> default(false)
  assert.equal(wf.trigger.skipBots, true); // real boolean preserved
  assert.equal(wf.trigger.onSynchronize, true); // missing -> default(true)
  assert.equal(wf.stages.holistic, true); // 0 -> default(true)
  assert.equal(wf.stages.docs, false); // real boolean preserved
  assert.equal(wf.verdict.blocking, true); // null -> default(true)
  assert.equal((wf as any).bogus, undefined); // unknown key dropped
});

test("advancedChanged: stage-only edits are basic, trigger/verdict edits are advanced", () => {
  const base = WORKFLOW_DEFAULTS;
  // Changing only which stages run is a BASIC edit (free users may do it).
  const stageEdit = normalizeWorkflow({ ...base, stages: { ...base.stages, holistic: false } });
  assert.equal(advancedChanged(base, stageEdit), false);
  // Changing the trigger policy is ADVANCED.
  const triggerEdit = normalizeWorkflow({ ...base, trigger: { ...base.trigger, skipDrafts: true } });
  assert.equal(advancedChanged(base, triggerEdit), true);
  // Changing the verdict mode is ADVANCED.
  const verdictEdit = normalizeWorkflow({ ...base, verdict: { blocking: false } });
  assert.equal(advancedChanged(base, verdictEdit), true);
});

test("paywall gate: free user may save stage changes but not advanced changes", () => {
  // Mirrors the PUT handler: advancedChanged(effectiveWorkflow(repo), next) is
  // what decides whether a free user's save is refused.
  const repo = { workflow: undefined };
  const current = effectiveWorkflow(repo);

  const stageSave = normalizeWorkflow({ ...current, stages: { ...current.stages, deferrals: false } });
  assert.equal(advancedChanged(current, stageSave), false, "stage change must be allowed for free");

  const advancedSave = normalizeWorkflow({ ...current, trigger: { ...current.trigger, skipBots: true } });
  assert.equal(advancedChanged(current, advancedSave), true, "advanced change must be refused for free");
});
