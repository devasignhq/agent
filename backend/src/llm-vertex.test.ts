// Offline: the Anthropic↔Gemini translation only, no network. Run:
//   LLM_PROVIDER= node --import tsx/esm --test src/llm-vertex.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkingLevel, type Content, type GenerateContentResponse } from "@google/genai";
import type Anthropic from "@anthropic-ai/sdk";
import {
  fromGeminiResponse,
  mapFinishReason,
  outputBudget,
  resolveVertexModel,
  systemText,
  toGeminiContents,
  vertexUsage,
} from "./llm-vertex.js";
import { runLookupLoop, estimateCostUsd } from "./llm.js";
import { config } from "./config.js";

const reply = (content: Content, finishReason = "STOP", usageMetadata = {}): GenerateContentResponse =>
  ({ candidates: [{ content, finishReason }], usageMetadata }) as GenerateContentResponse;

test("Claude tier ids map onto the Vertex model as thinking levels", () => {
  assert.deepEqual(resolveVertexModel("claude-haiku-4-5", "high"), { model: config.vertex.model, thinking: ThinkingLevel.LOW });
  assert.deepEqual(resolveVertexModel("claude-sonnet-5", "high"), { model: config.vertex.model, thinking: ThinkingLevel.MEDIUM });
  assert.deepEqual(resolveVertexModel("claude-opus-4-7", "high"), { model: config.vertex.model, thinking: ThinkingLevel.HIGH });
  assert.deepEqual(resolveVertexModel("gemini-2.5-pro", "high"), { model: "gemini-2.5-pro", thinking: ThinkingLevel.HIGH });
});

test("the thinking cap defaults to medium and never raises a lower tier", () => {
  assert.equal(config.vertex.thinking, "medium");
  assert.equal(resolveVertexModel("claude-opus-4-8").thinking, ThinkingLevel.MEDIUM);
  assert.equal(resolveVertexModel("claude-haiku-4-5").thinking, ThinkingLevel.LOW);
  assert.equal(resolveVertexModel(config.vertex.model).thinking, ThinkingLevel.MEDIUM);
  assert.equal(resolveVertexModel("claude-opus-4-8", "low").thinking, ThinkingLevel.LOW);
  assert.equal(resolveVertexModel("claude-opus-4-8", "bogus").thinking, ThinkingLevel.MEDIUM);
});

test("output budget adds thinking headroom and caps at the model max", () => {
  assert.equal(outputBudget(1024, ThinkingLevel.LOW), 1024 + 2048);
  assert.equal(outputBudget(60000, ThinkingLevel.HIGH), 65536);
});

test("system blocks flatten to one instruction string", () => {
  assert.equal(systemText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(systemText("x"), "x");
  assert.equal(systemText(undefined), undefined);
});

test("messages convert roles, media and tool turns", () => {
  const contents = toGeminiContents([
    { role: "user", content: "hi" },
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "BBB" } } as any,
        { type: "text", text: "look", cache_control: { type: "ephemeral" } },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "file body" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "vtx_0", name: "grep", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "vtx_0", content: "no hits" }] },
  ]);
  assert.deepEqual(contents, [
    { role: "user", parts: [{ text: "hi" }] },
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: "AAA" } },
        { inlineData: { mimeType: "application/pdf", data: "BBB" } },
        { text: "look" },
      ],
    },
    { role: "model", parts: [{ functionCall: { id: "c1", name: "read_file", args: { path: "a.ts" } } }] },
    { role: "user", parts: [{ functionResponse: { id: "c1", name: "read_file", response: { output: "file body" } } }] },
    { role: "model", parts: [{ functionCall: { name: "grep", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "grep", response: { output: "no hits" } } }] },
  ]);
});

test("responses convert to Anthropic blocks, skipping thought parts", () => {
  const msg = fromGeminiResponse(
    reply({
      role: "model",
      parts: [
        { text: "pondering", thought: true },
        { text: "answer" },
        { functionCall: { name: "submit", args: { ok: true } }, thoughtSignature: "sig" },
      ],
    }),
    "gemini-3.8-flash"
  );
  assert.deepEqual(
    msg.content.map((b) => b.type),
    ["text", "tool_use"]
  );
  const use = msg.content[1] as Anthropic.ToolUseBlock;
  assert.equal(use.name, "submit");
  assert.deepEqual(use.input, { ok: true });
  assert.ok(use.id.startsWith("vtx_"));
  assert.equal(msg.stop_reason, "tool_use");
});

test("finish reasons map to the stop reasons retryStructured relies on", () => {
  assert.equal(mapFinishReason("MAX_TOKENS", true), "max_tokens");
  assert.equal(mapFinishReason("STOP", true), "tool_use");
  assert.equal(mapFinishReason("STOP", false), "end_turn");
  assert.equal(mapFinishReason(undefined, false), "end_turn");
  assert.equal(mapFinishReason("SAFETY", false), "safety");
});

test("usage separates cached input and bills thinking as output", () => {
  assert.deepEqual(
    vertexUsage({ promptTokenCount: 1000, cachedContentTokenCount: 400, candidatesTokenCount: 50, thoughtsTokenCount: 200 }),
    { inputTokens: 600, outputTokens: 250, cacheReadTokens: 400, cacheCreationTokens: 0 }
  );
  assert.deepEqual(vertexUsage(undefined), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
});

test("the Vertex model is priced from config", () => {
  const M = 1_000_000;
  const z = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  assert.equal(estimateCostUsd(config.vertex.model, { ...z, inputTokens: M }), config.vertex.inputPerMTok);
  assert.equal(estimateCostUsd(config.vertex.model, { ...z, outputTokens: M }), config.vertex.outputPerMTok);
});

test("the lookup loop replays Gemini's model turn verbatim, keeping thought signatures", async () => {
  const lookupTurn: Content = {
    role: "model",
    parts: [{ functionCall: { id: "f1", name: "read_repo_file", args: { path: "x" } }, thoughtSignature: "SIG-1" }],
  };
  const sent: Content[][] = [];
  const responses = [
    reply(lookupTurn),
    reply({ role: "model", parts: [{ functionCall: { id: "f2", name: "verdict", args: { met: true } }, thoughtSignature: "SIG-2" }] }),
  ];
  const tool = { name: "verdict", description: "", inputSchema: {} };
  const lookup = { tool: { name: "read_repo_file", description: "", inputSchema: {} }, run: async () => "contents" };
  const res = await runLookupLoop({
    send: async (messages) => {
      sent.push(toGeminiContents(messages));
      return fromGeminiResponse(responses[sent.length - 1], "gemini-3.8-flash");
    },
    messages: [{ role: "user", content: "check it" }],
    tool,
    lookups: [lookup],
    maxLookupTurns: 3,
  });
  assert.deepEqual(res.input, { met: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[1][1], lookupTurn);
  assert.deepEqual(sent[1][2], {
    role: "user",
    parts: [{ functionResponse: { id: "f1", name: "read_repo_file", response: { output: "contents" } } }],
  });
});
