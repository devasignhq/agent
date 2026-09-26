// Gemini-on-Vertex adapter. llm.ts keeps speaking Anthropic's message shapes;
// this module translates them to and from generateContent.
import type Anthropic from "@anthropic-ai/sdk";
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from "@google/genai";
import { config } from "./config.js";

export type VertexTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type VertexToolChoice = { type: "any" } | { type: "tool"; name: string };
export type VertexUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };

const LEVELS = [ThinkingLevel.LOW, ThinkingLevel.MEDIUM, ThinkingLevel.HIGH];
const LEVEL_BY_NAME: Record<string, ThinkingLevel> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };

// Plan tiers are stored as Claude ids (repositories.defaultModel, billing plans),
// so the tier survives as a thinking level, capped at VERTEX_THINKING.
export function resolveVertexModel(
  requested: string,
  cap: string = config.vertex.thinking
): { model: string; thinking: ThinkingLevel } {
  const max = LEVEL_BY_NAME[cap] ?? ThinkingLevel.MEDIUM;
  const tier = !requested.startsWith("claude-")
    ? ThinkingLevel.HIGH
    : /haiku/.test(requested)
      ? ThinkingLevel.LOW
      : /sonnet/.test(requested)
        ? ThinkingLevel.MEDIUM
        : ThinkingLevel.HIGH;
  const thinking = LEVELS[Math.min(LEVELS.indexOf(tier), LEVELS.indexOf(max))];
  return { model: requested.startsWith("claude-") ? config.vertex.model : requested, thinking };
}

// Gemini counts thinking against maxOutputTokens (a 64-token probe spent 60 on
// thought and returned no text), so callers' budgets get headroom on top.
const THINKING_HEADROOM: Partial<Record<ThinkingLevel, number>> = {
  [ThinkingLevel.LOW]: 2048,
  [ThinkingLevel.MEDIUM]: 8192,
  [ThinkingLevel.HIGH]: 16384,
};
const MAX_OUTPUT_TOKENS = 65536;

export function outputBudget(maxTokens: number, thinking: ThinkingLevel): number {
  return Math.min(MAX_OUTPUT_TOKENS, maxTokens + (THINKING_HEADROOM[thinking] ?? 0));
}

// The exact Content each converted reply came from. Replaying it verbatim keeps
// Gemini 3's thoughtSignature parts, which multi-turn tool calls require.
const originalTurn = new WeakMap<object, Content>();

const SYNTHETIC_ID = "vtx_";

export function systemText(system: string | Anthropic.TextBlockParam[] | undefined): string | undefined {
  if (!system) return undefined;
  return typeof system === "string" ? system : system.map((b) => b.text).join("\n");
}

export function toGeminiContents(messages: Anthropic.MessageParam[]): Content[] {
  const toolNames = new Map<string, string>();
  const out: Content[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      out.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    for (const b of m.content) if (b.type === "tool_use") toolNames.set(b.id, b.name);
    const replay = originalTurn.get(m.content);
    if (replay) {
      out.push(replay);
      continue;
    }
    const parts: Part[] = [];
    for (const b of m.content) {
      // The pinned SDK's types predate `document` blocks, which llm.ts sends for PDFs.
      const media = b as { type: string; source?: { type: string; media_type: string; data: string } };
      if (b.type === "text") parts.push({ text: b.text });
      else if ((media.type === "image" || media.type === "document") && media.source?.type === "base64") {
        parts.push({ inlineData: { mimeType: media.source.media_type, data: media.source.data } });
      } else if (b.type === "tool_use") {
        parts.push({ functionCall: { ...geminiId(b.id), name: b.name, args: b.input as Record<string, unknown> } });
      } else if (b.type === "tool_result") {
        const output =
          typeof b.content === "string"
            ? b.content
            : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
        parts.push({
          functionResponse: { ...geminiId(b.tool_use_id), name: toolNames.get(b.tool_use_id) ?? "unknown", response: { output } },
        });
      }
    }
    if (parts.length) out.push({ role, parts });
  }
  return out;
}

function geminiId(id: string): { id?: string } {
  return id.startsWith(SYNTHETIC_ID) ? {} : { id };
}

export function mapFinishReason(finish: string | undefined, calledTool: boolean): string {
  if (finish === "MAX_TOKENS") return "max_tokens";
  if (calledTool) return "tool_use";
  if (!finish || finish === "STOP" || finish === "FINISH_REASON_UNSPECIFIED") return "end_turn";
  return finish.toLowerCase();
}

// promptTokenCount already includes cached tokens, and thinking bills as output.
export function vertexUsage(u: GenerateContentResponseUsageMetadata | undefined): VertexUsage {
  const cached = u?.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, (u?.promptTokenCount ?? 0) - cached),
    outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheCreationTokens: 0,
  };
}

export function fromGeminiResponse(resp: GenerateContentResponse, model: string): Anthropic.Message {
  const cand = resp.candidates?.[0];
  const content: Array<Anthropic.TextBlock | Anthropic.ToolUseBlock> = [];
  (cand?.content?.parts ?? []).forEach((p, i) => {
    if (p.thought) return;
    if (p.functionCall) {
      content.push({
        type: "tool_use",
        id: p.functionCall.id || `${SYNTHETIC_ID}${i}`,
        name: p.functionCall.name ?? "",
        input: p.functionCall.args ?? {},
      });
    } else if (p.text) {
      content.push({ type: "text", text: p.text, citations: null } as Anthropic.TextBlock);
    }
  });
  if (cand?.content) originalTurn.set(content, cand.content);
  const usage = vertexUsage(resp.usageMetadata);
  return {
    id: resp.responseId ?? "",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapFinishReason(cand?.finishReason, content.some((b) => b.type === "tool_use")),
    stop_sequence: null,
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
  } as unknown as Anthropic.Message;
}

let client: GoogleGenAI | null = null;
function vertexClient(): GoogleGenAI {
  client ??= new GoogleGenAI({
    vertexai: true,
    project: config.vertex.project,
    location: config.vertex.location,
    httpOptions: {
      // The Anthropic SDK retried 429/5xx for us; Vertex's shared pool 429s under contention.
      retryOptions: { attempts: 5, initialDelay: 1, maxDelay: 30 },
      // Priority PayGo is opt-in per request; "shared" skips Provisioned Throughput.
      ...(config.vertex.priority
        ? { headers: { "X-Vertex-AI-LLM-Request-Type": "shared", "X-Vertex-AI-LLM-Shared-Request-Type": "priority" } }
        : {}),
    },
  });
  return client;
}

let warnedDowngrade = false;

export async function vertexGenerate(
  model: string,
  contents: Content[],
  cfg: GenerateContentConfig
): Promise<GenerateContentResponse> {
  const resp = await vertexClient().models.generateContent({ model, contents, config: cfg });
  const traffic = resp.usageMetadata?.trafficType;
  if (config.vertex.priority && traffic && traffic !== "ON_DEMAND_PRIORITY" && !warnedDowngrade) {
    warnedDowngrade = true;
    console.warn(`[vertex] VERTEX_PRIORITY=1 but request was served as ${traffic}`);
  }
  return resp;
}

export async function vertexMessage(opts: {
  model: string;
  maxTokens: number;
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: VertexTool[];
  choice?: VertexToolChoice;
}): Promise<{ message: Anthropic.Message; model: string; usage: VertexUsage }> {
  const { model, thinking } = resolveVertexModel(opts.model);
  const resp = await vertexGenerate(model, toGeminiContents(opts.messages), {
    systemInstruction: systemText(opts.system),
    maxOutputTokens: outputBudget(opts.maxTokens, thinking),
    thinkingConfig: { thinkingLevel: thinking },
    ...(opts.tools?.length
      ? {
          tools: [
            {
              functionDeclarations: opts.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.inputSchema,
              })),
            },
          ],
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              ...(opts.choice?.type === "tool" ? { allowedFunctionNames: [opts.choice.name] } : {}),
            },
          },
        }
      : {}),
  });
  return { message: fromGeminiResponse(resp, model), model, usage: vertexUsage(resp.usageMetadata) };
}
