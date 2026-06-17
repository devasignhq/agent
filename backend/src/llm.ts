// Claude wrapper. Falls back to a deterministic mock when no API key is set,
// so local dev works end-to-end without billing.
import Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { config, isGeminiLive, isLLMLive } from "./config.js";

const client = isLLMLive() ? new Anthropic({ apiKey: config.llm.apiKey }) : null;

// Lets a job set the default model for every complete() call it makes, without
// threading a `model` arg through its whole call graph. Precedence: explicit
// opts.model > job context (withModel) > config.llm.model. Used to tier PR
// reviews by plan (Free → Haiku, Pro/Max → frontier); see runReviewJob.
const modelContext = new AsyncLocalStorage<string>();
export function withModel<T>(model: string, fn: () => T): T {
  return modelContext.run(model, fn);
}

// ─── Per-job token/cost accounting ───────────────────────────────────────────
// A review (or index build) fans out into many complete()/summarizeVideo() calls
// across its whole async call graph. withUsage() opens an AsyncLocalStorage scope
// that every call below records into, so the job can read one rolled-up
// input/output/cost figure to attach to its analytics event — without threading
// a usage arg through the pipeline. Outside a withUsage() scope, recordUsage()
// no-ops and currentUsage() returns null (e.g. unit tests that call complete()
// directly), so this never changes existing behaviour.
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
};

type UsageStore = { total: UsageTotals; byModel: Map<string, UsageTotals> };
const usageContext = new AsyncLocalStorage<UsageStore>();

function blankTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
}

export function withUsage<T>(fn: () => T): T {
  return usageContext.run({ total: blankTotals(), byModel: new Map() }, fn);
}

// Snapshot of the rolled-up totals for the current job, or null outside a scope.
export function currentUsage(): UsageTotals | null {
  const store = usageContext.getStore();
  return store ? { ...store.total } : null;
}

// USD per 1M tokens. Anthropic prices are pinned here (Opus 4.7/4.8 and the Haiku
// index/free-tier model); Gemini's live in config so a price change is env-only.
// A model absent from both still has its tokens counted — it just contributes $0,
// which is visible (a $0 cost with non-zero tokens) rather than silently wrong.
const ANTHROPIC_PRICES: Record<string, { inPerM: number; outPerM: number }> = {
  "claude-opus-4-8": { inPerM: 5, outPerM: 25 },
  "claude-opus-4-7": { inPerM: 5, outPerM: 25 },
  "claude-haiku-4-5": { inPerM: 1, outPerM: 5 },
};

function priceFor(model: string): { inPerM: number; outPerM: number } {
  if (ANTHROPIC_PRICES[model]) return ANTHROPIC_PRICES[model];
  if (model === config.gemini.model) {
    return { inPerM: config.gemini.inputPerMTok, outPerM: config.gemini.outputPerMTok };
  }
  return { inPerM: 0, outPerM: 0 };
}

// Cost mirrors the API's billing: cache *writes* cost ~1.25x base input, cache
// *reads* ~0.1x; uncached input and output bill at the table rate.
export function estimateCostUsd(
  model: string,
  u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
): number {
  const p = priceFor(model);
  return (
    (u.inputTokens * p.inPerM +
      u.outputTokens * p.outPerM +
      u.cacheCreationTokens * p.inPerM * 1.25 +
      u.cacheReadTokens * p.inPerM * 0.1) /
    1_000_000
  );
}

function recordUsage(
  model: string,
  u: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
  }
): void {
  const store = usageContext.getStore();
  if (!store) return;
  const delta = {
    inputTokens: u.inputTokens || 0,
    outputTokens: u.outputTokens || 0,
    cacheReadTokens: u.cacheReadTokens || 0,
    cacheCreationTokens: u.cacheCreationTokens || 0,
  };
  const cost = estimateCostUsd(model, delta);
  const add = (t: UsageTotals) => {
    t.inputTokens += delta.inputTokens;
    t.outputTokens += delta.outputTokens;
    t.cacheReadTokens += delta.cacheReadTokens;
    t.cacheCreationTokens += delta.cacheCreationTokens;
    t.costUsd += cost;
  };
  add(store.total);
  let perModel = store.byModel.get(model);
  if (!perModel) {
    perModel = blankTotals();
    store.byModel.set(model, perModel);
  }
  add(perModel);
}

export type LLMMessage = { role: "user" | "assistant"; content: string };

export async function complete(opts: {
  system?: string;
  messages: LLMMessage[];
  maxTokens?: number;
  cacheSystem?: boolean; // hint to use prompt caching when we re-use the system prompt
  model?: string;        // override the default; e.g. "claude-haiku-4-5" for per-file index summaries
}): Promise<string> {
  if (!client) return mockComplete(opts);

  const sys = opts.system
    ? opts.cacheSystem
      ? [{ type: "text" as const, text: opts.system, cache_control: { type: "ephemeral" as const } }]
      : opts.system
    : undefined;

  const model = opts.model || modelContext.getStore() || config.llm.model;
  const resp = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 2048,
    system: sys as any,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
  });

  // The API returns cache_*_input_tokens at runtime, but the pinned SDK's Usage
  // type only declares input/output — widen to read the cache fields.
  const usage = resp.usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  recordUsage(model, {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    cacheReadTokens: usage?.cache_read_input_tokens,
    cacheCreationTokens: usage?.cache_creation_input_tokens,
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text;
}

// Deterministic, structurally-correct mock so the rest of the pipeline can run
// without an API key. Returns JSON shaped like the live model would produce.
function mockComplete({ system, messages }: { system?: string; messages: LLMMessage[] }): string {
  const last = messages[messages.length - 1]?.content || "";
  if (system?.includes("criteria synthesis") || last.includes("acceptance criteria")) {
    return JSON.stringify({
      endGoal:
        "Reviewer should confirm the change delivers the described user-facing capability with no regressions in the touched files.",
      criteria: [
        { id: "c1", text: "All paths described in the linked issue are implemented." },
        { id: "c2", text: "No regressions in existing covered behavior." },
        { id: "c3", text: "User-facing copy matches the ticket's wording." },
        { id: "c4", text: "Edge cases listed in the issue are handled." },
      ],
    });
  }

  if (system?.includes("Linear issue matching")) {
    // Deterministic offline matcher: pick the first candidate whose block shares
    // a meaningful word (>3 chars) with the PR title; null if none. Lets both the
    // match and no-match paths run without a real model.
    const prTitle = (last.split("\n")[1] || "").toLowerCase();
    const words = prTitle.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const blocks = last.split(/\n(?=\d+\. id=)/).filter((b) => /id=/.test(b));
    for (const b of blocks) {
      const idM = b.match(/id=(\S+)/);
      if (idM && words.some((w) => b.toLowerCase().includes(w))) {
        return JSON.stringify({ id: idM[1] });
      }
    }
    return JSON.stringify({ id: null });
  }

  if (system?.includes("PR review") || last.includes("Review this PR")) {
    return JSON.stringify({
      verdict: "changes_requested",
      summary:
        "The diff covers the main path, but two acceptance criteria are not yet visibly satisfied. See per-criterion notes.",
      criteria: [
        { id: "c1", met: true, evidence: "src/handler.ts updated to cover the new path." },
        { id: "c2", met: true, evidence: "No tests were removed; existing assertions still hold." },
        { id: "c3", met: false, evidence: "Button label still reads 'Submit' instead of 'Send for review'." },
        { id: "c4", met: false, evidence: "Empty-state error from the ticket is not handled in the new branch." },
      ],
      comments: [
        {
          path: "src/handler.ts",
          line: 42,
          body: "Empty-state path from the ticket is not handled here — consider returning early with the empty payload.",
        },
      ],
      suggestions: [
        {
          criterionId: "c3",
          title: "Rename the submit button label",
          rationale: "The ticket specifies 'Send for review' as the user-facing copy; update the JSX label.",
          codeExample: "<button>Send for review</button>",
          fixPrompt:
            "Fix: Rename submit button label to 'Send for review'\n\n" +
            "File: src/handler.ts\n" +
            "Symbol: SubmitButton (JSX)\n\n" +
            "Issue:\n" +
            "The submit button still reads 'Submit' but the ticket specifies the user-facing copy as 'Send for review'. " +
            "Update the JSX label to match.\n\n" +
            "Expected behavior:\n" +
            "The submit button should display 'Send for review' so it matches the ticket's specified user-facing copy.\n\n" +
            "Suggested approach:\n" +
            "Open src/handler.ts, locate the submit button JSX, and replace the inner text with 'Send for review'. " +
            "If a translation key is used, update the en-US copy as well.\n\n" +
            "Relevant diff:\n" +
            "```diff\n" +
            "- <button>Submit</button>\n" +
            "+ <button>Send for review</button>\n" +
            "```",
        },
        {
          criterionId: "c4",
          title: "Handle the empty-state branch",
          rationale: "Return early with the empty payload before the main path so the new branch matches the ticket.",
          codeExample: "if (!items.length) return { items: [] };",
          fixPrompt:
            "Fix: Handle the empty-state branch in src/handler.ts\n\n" +
            "File: src/handler.ts\n" +
            "Symbol: handler\n\n" +
            "Issue:\n" +
            "The empty-state path described in the ticket is not handled in the new branch. " +
            "When items is empty, the handler currently falls through to the main path and may throw.\n\n" +
            "Expected behavior:\n" +
            "The handler should return an empty payload early when items is empty, avoiding a crash and matching the ticket's contract.\n\n" +
            "Suggested approach:\n" +
            "Return early with the empty payload before the main path runs, so the empty branch matches the ticket's contract.\n\n" +
            "Relevant diff:\n" +
            "```diff\n" +
            "  function handler(items) {\n" +
            "+   if (!items?.length) return { items: [] };\n" +
            "    // main path…\n" +
            "  }\n" +
            "```",
        },
      ],
    });
  }

  if (system?.includes("bug-fix synthesis")) {
    return JSON.stringify({
      title: "Empty state crashes when no items are returned",
      broken: "The video shows the app crashing with 'cannot read properties of undefined' when the list is empty.",
      expected: "The empty state should render a friendly placeholder instead of crashing.",
      fix: "Guard the render with a length check and return the EmptyState component when items is empty.",
      code: "if (!items?.length) return <EmptyState />;",
    });
  }

  if (system?.includes("maintainer-feedback goal refinement")) {
    // Cheap heuristic for the mock: comments whose body looks like a pure
    // acknowledgement ("lgtm", "ship it", "looks good") don't actually move
    // the goal. The production model decides this for itself; here we just
    // need a deterministic toggle so offline tests can exercise both paths.
    const lower = last.toLowerCase();
    const isAck = /\b(lgtm|looks good|ship it|approved|thanks!?|nice)\b/.test(lower);
    // refineGoalFromFeedback reads `addedCriteria` (the brand-new criteria the
    // comment introduces) — NOT a full `criteria` list — and derives `changed`
    // from whether any additions landed. Mirror that production contract here so
    // the offline changed-path actually fires.
    if (isAck) {
      return JSON.stringify({
        changed: false,
        endGoal: "",
        addedCriteria: [],
        rationale: "Comment reads as an acknowledgement; no new requirements detected.",
      });
    }
    return JSON.stringify({
      changed: true,
      endGoal:
        "Deliver the described capability and incorporate the maintainer's request to validate inputs before persisting.",
      addedCriteria: [
        { text: "Inputs are validated before persistence, per maintainer request." },
      ],
      rationale: "Maintainer asked for an explicit input-validation step before the persistence call.",
    });
  }

  if (system?.includes("implementation guide synthesis")) {
    return JSON.stringify({
      title: "Validate inputs before persistence",
      ask: "The maintainer wants an explicit validation step on the create path before we touch the database.",
      approach:
        "Add a zod schema next to the handler, parse the body with it, and short-circuit with a 400 when parsing fails. " +
        "Wire it into the existing handler before the db.insert call so we never persist a partial row.",
      code: "const Body = z.object({ name: z.string().min(1) });\nconst parsed = Body.safeParse(req.body);\nif (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });",
      references: [],
    });
  }

  // Per-file index summarisation (Haiku in production). Echo a structurally
  // valid record so the indexer can run end-to-end without billing.
  if (system?.includes("file summarisation")) {
    // Best-effort path extraction so multi-file callers see distinct mocks.
    const pathMatch = last.match(/^Path:\s*(\S+)/m);
    const path = pathMatch ? pathMatch[1] : "unknown";
    return JSON.stringify({
      summary: `[mock] Summary of ${path}. Real summaries require ANTHROPIC_API_KEY.`,
      exports: ["mockExport"],
      imports: ["./db.js"],
      securityFlags: [],
    });
  }

  // Deferred-work detection (Opus in production). Echo one deterministic
  // advisory deferral so the offline path exercises the finding card + the new
  // "Deferred / incomplete work" section end-to-end. The `concern` leads with
  // the "Contradicts …" prefix the real prompt asks for.
  if (system?.includes("deferred-work detection")) {
    return JSON.stringify({
      deferrals: [
        {
          path: "src/handler.ts",
          concern:
            "Contradicts criterion c1 — the added code defers part of the requested API: " +
            '"// TODO: pagination (limit/offset) deferred to a follow-up PR". The end goal asked for the full query API.',
          fixPrompt:
            "Fix: Implement the deferred pagination params in src/handler.ts\n\n" +
            "File: src/handler.ts\n" +
            "Symbol: listHandler\n\n" +
            "Issue:\n" +
            "A code comment concedes pagination was deferred to a follow-up, but the end goal required the full " +
            "query API including limit/offset. The PR ships without it.\n\n" +
            "Expected behavior:\n" +
            "The list endpoint should accept and honor limit/offset so the full query API agreed in the end goal works.\n\n" +
            "Suggested approach:\n" +
            "Parse `limit` and `offset` from the query string, validate them, and apply them to the query before " +
            "returning so the API matches what was agreed.\n\n" +
            "Relevant diff:\n" +
            "```diff\n" +
            "+ // TODO: pagination (limit/offset) deferred to a follow-up PR\n" +
            "```",
        },
      ],
      summary: "[mock] 1 self-admitted deferral detected.",
    });
  }

  // Holistic repo-review (Opus in production). Default to no blockers so
  // mocked offline runs pass cleanly; flip the WARN_FLAKY env to surface a
  // sample warn-severity item.
  if (system?.includes("holistic repo-review")) {
    const includeSample = process.env.WARN_FLAKY === "1";
    return JSON.stringify({
      regressions: [],
      criticalErrors: [],
      securityFindings: includeSample
        ? [
            {
              path: "src/handler.ts",
              concern: "[mock] flagged for visibility",
              severity: "warn",
              fixPrompt:
                "Fix: Sanity-check src/handler.ts (mock finding)\n\n" +
                "File: src/handler.ts\n" +
                "Symbol: n/a\n\n" +
                "Issue:\n" +
                "This is a deterministic mock finding emitted because WARN_FLAKY=1 was set. " +
                "Treat as a no-op example of the copy-prompt UI.\n\n" +
                "Expected behavior:\n" +
                "No real change is expected — this mock finding exists only to exercise the copy-prompt UI.\n\n" +
                "Suggested approach:\n" +
                "No action required — disable WARN_FLAKY to silence.\n\n" +
                "Relevant diff:\n" +
                "```diff\n" +
                "// mock\n" +
                "```",
            },
          ]
        : [],
      summary: "[mock] No blockers detected by the holistic repo-review step.",
    });
  }

  // Default: echo a terse acknowledgement
  return `[mock-llm] ${last.slice(0, 120)}`;
}

// ─── Video understanding via Gemini ─────────────────────────────────────────
// Gemini 2.5 Pro can watch videos and produce a structured summary that we
// pipe into Opus's context, so Opus can reason about Loom / YouTube / Vimeo
// references the human attached to a task. When no Gemini key is set we
// return a deterministic mock so the rest of the pipeline still runs.

export type VideoProvider = "youtube" | "loom" | "vimeo" | "other";

export type VideoSummary = {
  url: string;
  provider: VideoProvider;
  model: string;
  summary: string;
  keyMoments: Array<{ t: string; note: string }>;
  acceptanceSignals: string[]; // explicit UX/behavior the video shows
  unreliable: boolean;         // true when we couldn't actually watch it
};

export function detectVideoProvider(url: string): VideoProvider | null {
  if (!url) return null;
  const u = url.toLowerCase();
  if (/youtu\.be\/|youtube\.com\//.test(u)) return "youtube";
  if (/loom\.com\//.test(u)) return "loom";
  if (/vimeo\.com\//.test(u)) return "vimeo";
  return null;
}

const VIDEO_SYSTEM =
  "You are a video understanding assistant for a code-review platform. " +
  "Watch (or, if you cannot watch, infer cautiously from URL/title) the referenced video and emit ONLY JSON: " +
  '{"summary": string, "keyMoments": [{"t": "mm:ss", "note": string}], "acceptanceSignals": [string], "unreliable": boolean}. ' +
  "`summary` is 2–4 sentences describing what the video shows and what UX/behavior it implies. " +
  "`keyMoments` cites visible UX moments with timestamps. " +
  "`acceptanceSignals` are concrete, checkable claims the video makes about how the product should behave. " +
  "Set `unreliable=true` if you could not actually watch the video.";

export async function summarizeVideo(input: {
  url: string;
  title?: string;
  note?: string;
}): Promise<VideoSummary> {
  const provider = detectVideoProvider(input.url) || "other";

  if (!isGeminiLive()) return mockVideoSummary(input.url, provider);

  try {
    const parts: any[] = [];
    if (provider === "youtube") {
      // Gemini natively accepts YouTube URLs as fileData; it will watch.
      parts.push({ fileData: { fileUri: input.url, mimeType: "video/*" } });
    }
    parts.push({
      text:
        `Video URL: ${input.url}\n` +
        (input.title ? `Title: ${input.title}\n` : "") +
        (input.note ? `Author note: ${input.note}\n` : "") +
        `Provider: ${provider}\n\n` +
        (provider === "youtube"
          ? "Watch the video and emit the JSON schema described in the system prompt."
          : "You cannot directly ingest this provider's videos. Use the URL, title and note to infer the gist conservatively, and set unreliable=true. Emit the JSON schema described in the system prompt."),
    });

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent` +
      `?key=${encodeURIComponent(config.gemini.apiKey)}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: VIDEO_SYSTEM }] },
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as any;
    recordUsage(config.gemini.model, {
      inputTokens: body?.usageMetadata?.promptTokenCount,
      outputTokens: body?.usageMetadata?.candidatesTokenCount,
    });
    const text: string =
      body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
    const parsed = safeJSON(text) as Partial<VideoSummary> | null;
    return {
      url: input.url,
      provider,
      model: config.gemini.model,
      summary: parsed?.summary || "",
      keyMoments: Array.isArray(parsed?.keyMoments) ? parsed!.keyMoments! : [],
      acceptanceSignals: Array.isArray(parsed?.acceptanceSignals) ? parsed!.acceptanceSignals! : [],
      unreliable: provider !== "youtube" || Boolean(parsed?.unreliable),
    };
  } catch (err) {
    console.warn("[gemini] summarizeVideo failed:", err);
    return { ...mockVideoSummary(input.url, provider), unreliable: true };
  }
}

function mockVideoSummary(url: string, provider: VideoProvider): VideoSummary {
  return {
    url,
    provider,
    model: "mock-gemini",
    summary:
      `[mock] ${provider} video at ${url}. The author likely demonstrates the desired UX; ` +
      "real video understanding is disabled because GEMINI_API_KEY is not set.",
    keyMoments: [],
    acceptanceSignals: [],
    unreliable: true,
  };
}

function safeJSON(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ─── File understanding (PDFs / images attached to a Linear ticket) ──────────
// Claude reads the file directly via a document/image content block, so we don't
// need a separate PDF parser. Mirrors summarizeVideo: returns a short text
// summary that downstream criteria synthesis ingests as a `linear_file` source.
// Best-effort — returns null (and the review proceeds without it) on any error
// or unsupported media type. Falls back to a deterministic mock with no API key.
export async function summarizeLinearFile(input: {
  url: string;
  base64: string;
  mediaType: string;
}): Promise<string | null> {
  const isPdf = input.mediaType === "application/pdf";
  const isImage = input.mediaType.startsWith("image/");
  if (!isPdf && !isImage) return null;

  if (!client) {
    return `[mock] Attached ${isPdf ? "PDF" : "image"} at ${input.url}. Real file understanding requires ANTHROPIC_API_KEY.`;
  }

  try {
    const fileBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.base64 } }
      : { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.base64 } };
    const resp = await client.messages.create({
      model: config.llm.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            fileBlock,
            {
              type: "text",
              text:
                "This file is attached to a Linear ticket. In 3–6 sentences, summarise what it specifies or shows, " +
                "focusing on concrete, checkable requirements or acceptance signals a code reviewer would need.",
            },
          ] as any,
        },
      ],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return text.trim() || null;
  } catch (err) {
    console.warn("[llm] summarizeLinearFile failed:", input.url, err);
    return null;
  }
}

// ─── Guidance distillation (Workflow "Ingest context" materials) ─────────────
// Shared instruction for turning a maintainer-attached material (PDF, doc page,
// or video) into durable, checkable PR-review guidelines. review/guidance.ts
// reuses this for the text + video paths (via complete()); the PDF path below
// reads the file directly with Claude's document block, like summarizeLinearFile.
export const GUIDANCE_EXTRACT_SYSTEM =
  "You are DevAsign's guidance-indexing step. A repository maintainer attached a document or video to steer how their repo's pull requests are reviewed. " +
  "Distil it into a concise, self-contained list of concrete, checkable review guidelines a PR reviewer must enforce — conventions, requirements, do/don'ts, and acceptance signals. " +
  "Output a Markdown bullet list only, no preamble or closing remarks. Drop anything not actionable for reviewing code changes. Keep it under ~400 words.";

// Distil an uploaded PDF into review guidelines. Best-effort: returns null on any
// error so the ingest job can mark the item errored. Falls back to a deterministic
// mock with no API key.
export async function extractGuidanceFromPdf(input: {
  base64: string;
  title?: string;
}): Promise<string | null> {
  if (!client) {
    return (
      `[mock] Guidance distilled from PDF${input.title ? ` "${input.title}"` : ""}. ` +
      "Real extraction requires ANTHROPIC_API_KEY.\n- Follow the conventions described in the attached document."
    );
  }
  try {
    const resp = await client.messages.create({
      model: config.llm.model,
      max_tokens: 1024,
      system: GUIDANCE_EXTRACT_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.base64 } },
            {
              type: "text",
              text: `Distil this document${input.title ? ` ("${input.title}")` : ""} into review guidelines per the system instruction.`,
            },
          ] as any,
        },
      ],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return text.trim() || null;
  } catch (err) {
    console.warn("[llm] extractGuidanceFromPdf failed:", err);
    return null;
  }
}
