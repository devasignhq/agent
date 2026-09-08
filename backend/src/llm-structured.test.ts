// node --import tsx/esm --test src/llm-structured.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { completeStructured, retryStructured, type LLMMessage, type StructuredResult } from "./llm.js";
import { reviewVerdictTool } from "./review/tools.js";

const messages: LLMMessage[] = [{ role: "user", content: "# Criteria\n- 1: does a thing\n- 2: does another" }];
const ok = (value: unknown): StructuredResult => ({ input: value, text: "", stopReason: "tool_use", raw: JSON.stringify(value) });
const cut = (raw: string): StructuredResult => ({ input: null, text: "", stopReason: "max_tokens", raw });
const prose = (text: string): StructuredResult => ({ input: null, text, stopReason: "end_turn", raw: text });

function scripted(results: StructuredResult[]) {
  const calls: Array<{ maxTokens: number; messages: LLMMessage[] }> = [];
  const call = async (maxTokens: number, msgs: LLMMessage[]) => {
    calls.push({ maxTokens, messages: msgs });
    return results.shift() ?? prose("");
  };
  return { call, calls };
}

const validate = (input: unknown) =>
  input && typeof input === "object" && (input as any).ok === true
    ? ({ ok: true, value: input } as const)
    : ({ ok: false, reason: "missing ok flag" } as const);

test("a max_tokens cut re-asks with the next budget and the same messages", async () => {
  const { call, calls } = scripted([cut('{"partial":'), ok({ ok: true })]);
  const out = await retryStructured({ call, messages, budgets: [100, 200], validate, repairPrompt: () => "repair" });
  assert.deepEqual(out.value, { ok: true });
  assert.deepEqual(calls.map((c) => c.maxTokens), [100, 200]);
  assert.equal(calls[1].messages, messages);
  assert.equal(out.attempts[0].kind, "initial");
  assert.equal(out.attempts[0].reason, "output cut at max_tokens=100");
  assert.equal(out.attempts[1].kind, "budget");
  assert.equal(out.attempts[1].reason, null);
});

test("a complete but invalid answer gets one repair pass replaying the bad output", async () => {
  const { call, calls } = scripted([ok({ ok: false, junk: 1 }), ok({ ok: true })]);
  const out = await retryStructured({ call, messages, budgets: [100, 200], validate, repairPrompt: (r) => `fix: ${r}` });
  assert.deepEqual(out.value, { ok: true });
  assert.equal(calls[1].maxTokens, 100, "repair keeps the same budget");
  assert.equal(calls[1].messages.length, 3);
  assert.equal(calls[1].messages[1].role, "assistant");
  assert.match(calls[1].messages[1].content, /"junk":1/);
  assert.equal(calls[1].messages[2].content, "fix: missing ok flag");
  assert.equal(out.attempts[1].kind, "repair");
});

test("prose instead of a tool call is repaired, and the excerpt records head and tail", async () => {
  const long = "x".repeat(1200);
  const { call } = scripted([prose(long), prose("still no")]);
  const out = await retryStructured({ call, messages, budgets: [100], validate, repairPrompt: () => "repair" });
  assert.equal(out.value, null);
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0].reason, "no tool call in the response");
  assert.equal(out.attempts[0].head.length, 500);
  assert.equal(out.attempts[0].tail.length, 500);
  assert.equal(out.attempts[1].tail, "", "short output has no separate tail");
  assert.equal(out.lastStopReason, "end_turn");
});

test("exhausted budgets stop with lastStopReason max_tokens and no repair", async () => {
  const { call, calls } = scripted([cut("a"), cut("b"), ok({ ok: true })]);
  const out = await retryStructured({ call, messages, budgets: [100, 200], validate, repairPrompt: () => "repair" });
  assert.equal(out.value, null);
  assert.equal(calls.length, 2);
  assert.equal(out.lastStopReason, "max_tokens");
});

test("maxCalls caps the total number of calls", async () => {
  const { call, calls } = scripted([cut("a"), cut("b"), cut("c"), ok({ ok: true })]);
  const out = await retryStructured({ call, messages, budgets: [1, 2, 3, 4], validate, repairPrompt: () => "r", maxCalls: 2 });
  assert.equal(out.value, null);
  assert.equal(calls.length, 2);
});

test("onAttempt sees every attempt including the successful one", async () => {
  const { call } = scripted([cut("a"), ok({ ok: true })]);
  const seen: string[] = [];
  await retryStructured({ call, messages, budgets: [1, 2], validate, repairPrompt: () => "r", onAttempt: (a) => seen.push(`${a.n}:${a.kind}:${a.reason ?? "ok"}`) });
  assert.deepEqual(seen, ["1:initial:output cut at max_tokens=1", "2:budget:ok"]);
});

test("offline completeStructured parses the mock's JSON into input", async () => {
  const res = await completeStructured({
    system: "You are DevAsign's PR review step.",
    messages,
    tool: reviewVerdictTool,
  });
  assert.equal(res.stopReason, "tool_use");
  assert.ok(res.input && typeof res.input === "object");
  assert.ok(Array.isArray((res.input as any).criteria));
  assert.equal(res.raw, res.text);
});
