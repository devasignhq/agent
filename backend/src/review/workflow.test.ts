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
  // pipeline did before workflows existed. `defects` is the deliberate exception
  // to "reproduces prior behavior": bug detection ships on by default, because
  // default-off would leave the criteria-only blind spot open for every repo
  // that never opens the Workflow screen. `crossRepo` is the mirror case — it is
  // advisory-only, so default-off leaves no blind spot and costs nobody tokens.
  assert.deepEqual(wf.stages, {
    holistic: true,
    defects: true,
    docs: true,
    deferrals: true,
    crossRepo: false,
    verify: true,
  });
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

test("normalizeWorkflow keeps valid stage prompts, trims, caps length, drops the rest", () => {
  const wf = normalizeWorkflow({
    ...WORKFLOW_DEFAULTS,
    prompts: {
      review: "  Focus on error handling.  ", // trimmed
      holistic: "x".repeat(5000),             // capped at 2000
      criteria: "   ",                        // blank -> dropped
      docs: 123,                              // non-string -> dropped
      bogus: "nope",                          // unknown key -> dropped
    },
  });
  assert.equal(wf.prompts?.review, "Focus on error handling.");
  assert.equal(wf.prompts?.holistic?.length, 2000);
  assert.equal(wf.prompts?.criteria, undefined);
  assert.equal(wf.prompts?.docs, undefined);
  assert.equal((wf.prompts as any)?.bogus, undefined);
});

test("normalizeWorkflow defaults prompts to an empty object", () => {
  assert.deepEqual(normalizeWorkflow({ version: 1 }).prompts, {});
});

test("effectiveWorkflow fills prompts with {} and merges stored ones", () => {
  assert.deepEqual(effectiveWorkflow({ workflow: undefined }).prompts, {});
  const wf = effectiveWorkflow({
    workflow: { version: 1, prompts: { review: "be strict" } } as any,
  });
  assert.deepEqual(wf.prompts, { review: "be strict" });
});

test("advancedChanged: editing a stage prompt is an ADVANCED change", () => {
  const base = WORKFLOW_DEFAULTS;
  const promptEdit = normalizeWorkflow({ ...base, prompts: { review: "focus on tests" } });
  assert.equal(advancedChanged(base, promptEdit), true, "setting a prompt is advanced");
  assert.equal(advancedChanged(promptEdit, base), true, "clearing a prompt is advanced");
  // Two equivalent prompt sets are NOT a change.
  const same = normalizeWorkflow({ ...base, prompts: { review: "focus on tests" } });
  assert.equal(advancedChanged(promptEdit, same), false, "identical prompts are not a change");
});

test("normalizeWorkflow coerces the actions step and defaults it off", () => {
  const def = normalizeWorkflow({ version: 1 });
  assert.deepEqual(def.actions, { enabled: false, workflow: "", runWhen: "passed" });

  const wf = normalizeWorkflow({
    ...WORKFLOW_DEFAULTS,
    actions: { enabled: "yes", workflow: "  deploy.yml  ", runWhen: "weird" },
  });
  assert.equal(wf.actions?.enabled, false);          // non-bool -> false
  assert.equal(wf.actions?.workflow, "deploy.yml");  // trimmed
  assert.equal(wf.actions?.runWhen, "passed");        // invalid enum -> default

  const capped = normalizeWorkflow({ ...WORKFLOW_DEFAULTS, actions: { enabled: true, workflow: "x".repeat(500), runWhen: "always" } });
  assert.equal(capped.actions?.enabled, true);
  assert.equal(capped.actions?.workflow.length, 200); // capped
  assert.equal(capped.actions?.runWhen, "always");
});

test("effectiveWorkflow fills the actions defaults and merges stored ones", () => {
  assert.deepEqual(effectiveWorkflow({ workflow: undefined }).actions, {
    enabled: false,
    workflow: "",
    runWhen: "passed",
  });
  const wf = effectiveWorkflow({
    workflow: { version: 1, actions: { enabled: true, workflow: "ci.yml" } } as any,
  });
  assert.deepEqual(wf.actions, { enabled: true, workflow: "ci.yml", runWhen: "passed" });
});

test("advancedChanged: editing the actions step is an ADVANCED change", () => {
  const base = WORKFLOW_DEFAULTS;
  const enableEdit = normalizeWorkflow({ ...base, actions: { enabled: true, workflow: "ci.yml", runWhen: "passed" } });
  assert.equal(advancedChanged(base, enableEdit), true, "enabling actions is advanced");
  const runWhenEdit = normalizeWorkflow({ ...enableEdit, actions: { enabled: true, workflow: "ci.yml", runWhen: "always" } });
  assert.equal(advancedChanged(enableEdit, runWhenEdit), true, "changing runWhen is advanced");
  const same = normalizeWorkflow({ ...enableEdit });
  assert.equal(advancedChanged(enableEdit, same), false, "identical actions are not a change");
});

test("verify stage defaults on with e2e:auto / failOn:never and normalizes", () => {
  const def = effectiveWorkflow({ workflow: undefined });
  assert.equal(def.stages.verify, true);
  assert.deepEqual(def.verify, { e2e: "auto", failOn: "never" });

  const legacy = effectiveWorkflow({ workflow: { version: 1, stages: { holistic: false } } as any });
  assert.equal(legacy.stages.verify, true, "rows written before verify existed still run it");
  assert.deepEqual(legacy.verify, { e2e: "auto", failOn: "never" });

  const wf = normalizeWorkflow({
    ...WORKFLOW_DEFAULTS,
    stages: { ...WORKFLOW_DEFAULTS.stages, verify: false },
    verify: { e2e: "never", failOn: "bogus" },
    prompts: { verify: "  prefer integration tests  " },
  });
  assert.equal(wf.stages.verify, false);
  assert.deepEqual(wf.verify, { e2e: "never", failOn: "never" });
  assert.equal(wf.prompts?.verify, "prefer integration tests");

  const bad = normalizeWorkflow({ version: 1, verify: { e2e: "sometimes", failOn: "verdict" } });
  assert.deepEqual(bad.verify, { e2e: "auto", failOn: "verdict" });
  // Toggling the stage is a BASIC edit, like every other stage.
  assert.equal(advancedChanged(WORKFLOW_DEFAULTS, wf), true, "the prompt edit is advanced");
  const stageOnly = normalizeWorkflow({ ...WORKFLOW_DEFAULTS, stages: { ...WORKFLOW_DEFAULTS.stages, verify: false } });
  assert.equal(advancedChanged(WORKFLOW_DEFAULTS, stageOnly), false);
});
