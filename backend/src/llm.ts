// Claude wrapper. Falls back to a deterministic mock when no API key is set,
// so local dev works end-to-end without billing.
import Anthropic from "@anthropic-ai/sdk";
import { config, isGeminiLive, isLLMLive } from "./config.js";

const client = isLLMLive() ? new Anthropic({ apiKey: config.llm.apiKey }) : null;

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

  const resp = await client.messages.create({
    model: opts.model || config.llm.model,
    max_tokens: opts.maxTokens ?? 2048,
    system: sys as any,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
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
        },
        {
          criterionId: "c4",
          title: "Handle the empty-state branch",
          rationale: "Return early with the empty payload before the main path so the new branch matches the ticket.",
          codeExample: "if (!items.length) return { items: [] };",
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
    if (isAck) {
      return JSON.stringify({
        changed: false,
        endGoal: "",
        criteria: [],
        rationale: "Comment reads as an acknowledgement; no new requirements detected.",
      });
    }
    return JSON.stringify({
      changed: true,
      endGoal:
        "Deliver the described capability and incorporate the maintainer's request to validate inputs before persisting.",
      criteria: [
        { id: "c1", text: "All paths described in the linked issue are implemented." },
        { id: "c2", text: "No regressions in existing covered behavior." },
        { id: "c3", text: "User-facing copy matches the ticket's wording." },
        { id: "c4", text: "Edge cases listed in the issue are handled." },
        { id: "c5", text: "Inputs are validated before persistence, per maintainer request." },
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

  // Holistic repo-review (Opus in production). Default to no blockers so
  // mocked offline runs pass cleanly; flip the WARN_FLAKY env to surface a
  // sample warn-severity item.
  if (system?.includes("holistic repo-review")) {
    const includeSample = process.env.WARN_FLAKY === "1";
    return JSON.stringify({
      regressions: [],
      criticalErrors: [],
      securityFindings: includeSample
        ? [{ path: "src/handler.ts", concern: "[mock] flagged for visibility", severity: "warn" }]
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
