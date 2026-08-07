// Claude wrapper. Falls back to a deterministic mock when no API key is set,
// so local dev works end-to-end without billing.
import Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { config, isGeminiLive, isLLMLive } from "./config.js";
import { hostMatches } from "./ssrf.js";

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

export type CompletionResult = { text: string; stopReason: string | null };

export async function complete(opts: {
  system?: string;
  messages: LLMMessage[];
  maxTokens?: number;
  cacheSystem?: boolean; // hint to use prompt caching when we re-use the system prompt
  model?: string;        // override the default; e.g. "claude-haiku-4-5" for per-file index summaries
}): Promise<string> {
  return (await completeWithMeta(opts)).text;
}

// Like complete(), but also surfaces the API's stop_reason so callers can tell
// a complete response from one cut off at max_tokens (a truncated JSON payload
// can otherwise still "parse" via a smaller embedded object).
export async function completeWithMeta(opts: {
  system?: string;
  messages: LLMMessage[];
  maxTokens?: number;
  cacheSystem?: boolean;
  model?: string;
}): Promise<CompletionResult> {
  if (!client) return { text: mockComplete(opts), stopReason: "end_turn" };

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
  return { text, stopReason: resp.stop_reason ?? null };
}

// Deterministic, structurally-correct mock so the rest of the pipeline can run
// without an API key. Returns JSON shaped like the live model would produce.
function mockComplete({ system, messages }: { system?: string; messages: LLMMessage[] }): string {
  const last = messages[messages.length - 1]?.content || "";

  // MUST stay ahead of the criteria-synthesis branch below: the judge's user
  // message quotes the drafted list, so it contains the literal phrase
  // "acceptance criteria" and would otherwise be answered with criteria.
  // Returns a clean verdict per criterion, echoing the `[n]` indices out of the
  // prompt so scoreCriteria merges them (hardcoded indices would zero-match).
  if (system?.includes("bounty criteria evaluation")) {
    const indices = [...last.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    return JSON.stringify({
      results: indices.map((index) => ({ index, flags: [], note: "mock verdict: sound" })),
    });
  }

  if (system?.includes("criteria synthesis") || last.includes("acceptance criteria")) {
    return JSON.stringify({
      endGoal:
        "Reviewer should confirm the change delivers the described user-facing capability with no regressions in the touched files.",
      criteria: [
        { id: "1", text: "All paths described in the linked issue are implemented." },
        { id: "2", text: "No regressions in existing covered behavior." },
        { id: "3", text: "User-facing copy matches the ticket's wording." },
        { id: "4", text: "Edge cases listed in the issue are handled." },
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
    // Echo the criterion ids from the prompt's leading `# Criteria` section
    // (buildCriteriaSection renders `- ${id}: ${text}`) so seeded ids like
    // bounty-1..N get verdicts that actually merge back onto the criteria —
    // hardcoded "1".."4" would zero-match them and trip the empty-verdict guard.
    const critSection = last.split(/\n(?=# )/)[0] || "";
    const promptIds = [...critSection.matchAll(/^- ([^\s:]+):/gm)].map((m) => m[1]);
    const ids = promptIds.length ? promptIds : ["1", "2", "3", "4"];
    const metCount = Math.ceil(ids.length / 2);
    const unmetIds = ids.slice(metCount);
    return JSON.stringify({
      verdict: unmetIds.length ? "changes_requested" : "passed",
      summary:
        "The diff covers the main path, but two acceptance criteria are not yet visibly satisfied. See per-criterion notes.",
      // First met criterion carries evidenceCode and the first unmet one a
      // structured suggestedChange, so the new structured-fields path (parser →
      // merge → renderer → timeline meta) is exercised offline end-to-end.
      criteria: ids.map((id, i) =>
        i < metCount
          ? {
              id,
              met: true,
              evidence: "src/handler.ts updated to cover the new path.",
              evidenceCode:
                i === 0
                  ? {
                      path: "src/handler.ts",
                      startLine: 40,
                      language: "typescript",
                      code: "if (!items?.length) return { items: [] };",
                    }
                  : null,
              suggestedChange: null,
            }
          : {
              id,
              met: false,
              evidence: "Button label still reads 'Submit' instead of 'Send for review'.",
              evidenceCode: null,
              suggestedChange:
                id === unmetIds[0]
                  ? {
                      path: "src/handler.ts",
                      startLine: 52,
                      original: "<button>Submit</button>",
                      suggested: "<button>Send for review</button>",
                    }
                  : null,
            }
      ),
      comments: [
        {
          path: "src/handler.ts",
          line: 42,
          body: "Empty-state path from the ticket is not handled here — consider returning early with the empty payload.",
        },
      ],
      suggestions: [
        {
          criterionId: unmetIds[0] ?? "3",
          title: "Rename the submit button label",
          rationale: "The ticket specifies 'Send for review' as the user-facing copy; update the JSX label.",
          severity: "warn",
          suggestedChange: {
            path: "src/handler.ts",
            startLine: 52,
            original: "<button>Submit</button>",
            suggested: "<button>Send for review</button>",
          },
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
          criterionId: unmetIds[1] ?? unmetIds[0] ?? "4",
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
    // Cheap heuristics for the mock so offline tests can exercise every path:
    //   - pure acknowledgement ("lgtm", "ship it") → no change, dispute, or reopen
    //   - "false positive" / "already satisfied" → dispute the [currently UNMET] ids
    //   - "re-open" / "isn't actually done" → reopen the [currently MET] ids
    //   - new-work language ("add", "please", "validate") → add a criterion
    // The production model decides all of this itself; this is just a deterministic
    // toggle. A single comment can add, dispute, and reopen at once.
    const lower = last.toLowerCase();
    const isAck = /\b(lgtm|looks good|ship it|approved|thanks!?|nice)\b/.test(lower);
    const isDispute = /false positive|not (a )?real|already (satisfied|met|handled|covered)/.test(lower);
    const isReopen =
      /re-?open|not (actually )?(done|satisfied|met|finished|complete|implemented)|isn'?t (actually )?(done|satisfied|met|finished|complete|implemented)|wrongly passed|passed (it )?wrongly|regress/.test(
        lower
      );
    const wantsAddition = /\b(add|also|please|validate|require|must|need)\b/.test(lower);
    // The userText renders criteria as "- cN: [currently UNMET|MET|not yet evaluated] ...".
    const unmetIds = [...last.matchAll(/- (c\d+): \[currently UNMET\]/g)].map((m) => m[1]);
    const metIds = [...last.matchAll(/- (c\d+): \[currently MET\]/g)].map((m) => m[1]);
    // Honor ids the comment names explicitly. Scope the search to the maintainer
    // feedback body (the criteria list above also contains every id), and fall
    // back to all ids of that state when the body names none.
    const fb = (last.split("## Maintainer feedback")[1] || last).split("## Referenced")[0];
    const named = (ids: string[]) => {
      const inBody = ids.filter((id) => new RegExp(`\\b${id}\\b`, "i").test(fb));
      return inBody.length ? inBody : ids;
    };
    const disputedCriteria = isDispute
      ? named(unmetIds).map((id) => ({ id, claim: "Maintainer says this is already satisfied by existing code." }))
      : [];
    const reopenedCriteria = isReopen
      ? named(metIds).map((id) => ({ id, claim: "Maintainer says this is not actually satisfied." }))
      : [];
    if (isAck) {
      return JSON.stringify({
        changed: false,
        endGoal: "",
        addedCriteria: [],
        disputedCriteria: [],
        reopenedCriteria: [],
        rationale: "Comment reads as an acknowledgement; no new requirements detected.",
      });
    }
    // refineGoalFromFeedback reads `addedCriteria` (the brand-new criteria the
    // comment introduces) and derives `changed` from whether any additions
    // landed. A pure dispute/reopen (no new-work language) adds nothing.
    const addedCriteria = (!isDispute && !isReopen) || wantsAddition
      ? [{ text: "Inputs are validated before persistence, per maintainer request." }]
      : [];
    return JSON.stringify({
      changed: addedCriteria.length > 0,
      endGoal: addedCriteria.length
        ? "Deliver the described capability and incorporate the maintainer's request to validate inputs before persisting."
        : "",
      addedCriteria,
      disputedCriteria,
      reopenedCriteria,
      rationale: addedCriteria.length
        ? "Maintainer asked for an explicit input-validation step before the persistence call."
        : reopenedCriteria.length
          ? "Comment re-opens one or more previously-met criteria."
          : "Comment disputes one or more unmet findings as false positives.",
    });
  }

  if (system?.includes("maintainer-dispute re-evaluation")) {
    // Re-verify the disputed criteria. Deterministic toggle: a claim the comment
    // backs with no verifiable detail ("trust me", "I can't verify") stays unmet;
    // otherwise the mock confirms the maintainer (finding was a false positive).
    // Ids are read from the "- cN:" lines of the disputed-criteria block.
    const ids = [...new Set([...last.matchAll(/- (c\d+):/g)].map((m) => m[1]))];
    const unverifiable = /can.?t verify|cannot verify|trust me|no evidence|without checking|not sure/i.test(last);
    return JSON.stringify({
      results: ids.map((id) =>
        unverifiable
          ? {
              id,
              met: false,
              evidence:
                "Re-checked the diff and repo index; found no concrete code that satisfies this criterion.",
            }
          : {
              id,
              met: true,
              evidence: `Verified against the codebase: existing code satisfies ${id}, as the maintainer noted.`,
            }
      ),
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

  // Per-file security audit sub-pass (frontier model in production). Echo an
  // empty, structurally-valid result so the indexer's gated scan can run offline
  // without billing — it only fires when the summariser flagged the file, which
  // the mock above never does, so this is defensive correctness for dev runs.
  if (system?.includes("file security audit")) {
    return JSON.stringify({ vulnerabilities: [] });
  }

  // Security audit agent (the whole-codebase auditor in security/agent.ts,
  // frontier model in production). Default to a clean scan so offline audits
  // run without billing. Set SECURITY_SAMPLE=1 to emit one finding carrying the
  // FORBIDDEN severity/confidence pair (high + needs_human) — buildFindingRows
  // must clamp it to medium, so this exercises the confidence cap through the
  // real scanFile path end-to-end.
  if (system?.includes("security audit agent")) {
    if (process.env.SECURITY_SAMPLE !== "1") {
      return JSON.stringify({ findings: [] });
    }
    return JSON.stringify({
      findings: [
        {
          stable_key: "mock-payout-route-missing-auth",
          class: "missing-authz",
          cwe: "CWE-862",
          severity: "high",
          confidence: "needs_human",
          title: "[mock] payout route appears to lack an authorization check",
          concern:
            "[mock] The payout handler reads the account id from the request body and moves funds without an " +
            "in-file authorization check. Auth middleware may be applied in the router — that is the unverified " +
            "assumption this finding depends on.",
          evidence: 'line 42: `const accountId = req.body.accountId;`',
          symbol: "payoutHandler",
          line: 42,
          exploit_narrative: [
            "Attacker authenticates as any user and calls POST /payout directly.",
            "They supply another tenant's accountId in the request body.",
            "Funds move from the victim account because no ownership check runs.",
          ],
          blast_radius: "Any authenticated user can move funds from any account.",
          invariant: "Value-bearing endpoints must verify the caller owns the target account.",
          remediation: "Add an ownership check in payoutHandler before the transfer call.",
          regression_test: "POST /payout with a foreign accountId returns 403 and moves nothing.",
        },
      ],
    });
  }

  // PR security review backstop (frontier model in production). Returns no
  // findings offline so the security pass runs clean without billing.
  if (system?.includes("PR security review step")) {
    return JSON.stringify({ securityFindings: [], summary: "[mock] No vulnerabilities surfaced." });
  }

  // Pre-existing vuln re-verification (frontier model in production). Offline,
  // report every known vuln as STILL PRESENT — the safe default — so a mocked
  // run never spuriously drops a stored vuln. The `results` array is intentionally
  // empty: partitionReverifiedVulns treats "no verdict" as still-present.
  if (system?.includes("pre-existing vulnerability re-verification step")) {
    return JSON.stringify({ results: [] });
  }

  // New-commit intent review (re-reviews only). Echo a deterministic summary and
  // empty arrays so the offline path renders the "New commits since last review"
  // section end-to-end without billing or minting spurious criteria.
  if (system?.includes("new-commit intent review")) {
    return JSON.stringify({
      addedCriteria: [],
      intentFindings: [],
      summary: "[mock] Reviewed the new commits against their stated intent; no new criteria or concerns.",
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
          line: 12,
          concern:
            "Contradicts goal: criterion c1 — the added code defers part of the requested API: " +
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
      preexistingVulns: [],
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

  // General defect review (frontier model in production). Default to a clean
  // result so mocked offline runs still pass — this stage GATES the merge, so a
  // sample finding by default would fail every offline pipeline test. Set
  // DEFECT_SAMPLE=1 to emit one blocker-severity defect and exercise the gate,
  // the "Bugs and correctness issues" section, and the timeline finding card
  // end-to-end without billing.
  if (system?.includes("defect review step")) {
    if (process.env.DEFECT_SAMPLE !== "1") {
      return JSON.stringify({ defects: [], summary: "[mock] No defects surfaced in the changed code." });
    }
    return JSON.stringify({
      defects: [
        {
          path: "src/handler.ts",
          line: 42,
          suggestedChange: {
            path: "src/handler.ts",
            startLine: 42,
            original: "  } catch (err) {\n    logger.warn(\"write failed\", err);\n  }",
            suggested: "  } catch (err) {\n    logger.warn(\"write failed\", err);\n    throw err;\n  }",
          },
          defectClass: "unhandled-error",
          concern:
            "[mock] The catch block logs the provider error and falls through to the success response, " +
            "so a failed write is reported to the caller as if it succeeded.",
          failureScenario:
            "When the datastore rejects the write (a 500 or a timeout), listHandler still returns 200 with an " +
            "empty body, and the caller records the operation as complete.",
          severity: "blocker",
          fixPrompt:
            "Fix: Propagate the write failure instead of swallowing it\n\n" +
            "File: src/handler.ts\n" +
            "Symbol: listHandler\n\n" +
            "Issue:\n" +
            "The catch block logs the error and continues into the success path, so a failed write is " +
            "indistinguishable from a successful one to the caller.\n\n" +
            "Expected behavior:\n" +
            "A failed write should surface as an error response so the caller can retry rather than record " +
            "a phantom success.\n\n" +
            "Suggested approach:\n" +
            "Rethrow (or return an error result) from the catch block and let the route's error handler map it " +
            "to a 5xx.\n\n" +
            "Relevant diff:\n" +
            "```diff\n" +
            "+ } catch (err) {\n" +
            "+   console.error(err);\n" +
            "+ }\n" +
            "```",
        },
      ],
      summary: "[mock] 1 blocking defect detected in the changed code.",
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

// hostMatches (apex-or-subdomain host check) lives in ssrf.ts — one definition
// of "is this host theirs?" for every caller. The Linear attachment path is what
// happened when there were two.

// Classify a video URL by its *parsed hostname*, not a substring match. A raw
// regex like /youtube\.com\// matches the string anywhere — including a path or
// query param — so an attacker-controlled URL such as https://internal/?x=youtube.com/
// would be tagged "youtube" and handed to Gemini as a fileData fileUri to fetch
// (SSRF / unintended fetch; these URLs come from task attachments and GitHub
// comments). Requiring an http(s) scheme and an allowlisted hostname means only
// genuine provider URLs reach the direct-ingest path; everything else returns
// null and falls back to the conservative inference path. The strict host match
// also makes private/internal hosts unclassifiable — an attacker can't point an
// allowlisted domain at an internal address.
export function detectVideoProvider(url: string): VideoProvider | null {
  if (!url) return null;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null; // unparseable → not a recognized provider
  }
  if (hostMatches(host, "youtube.com") || hostMatches(host, "youtu.be")) return "youtube";
  if (hostMatches(host, "loom.com")) return "loom";
  if (hostMatches(host, "vimeo.com")) return "vimeo";
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
      `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent`;
    const res = await fetch(endpoint, {
      method: "POST",
      // The key goes in a header, never the URL: request URLs are what proxy
      // access logs, APM spans and error trackers capture by default, and this
      // is a long-lived credential on the org's billing account. Google accepts
      // the same key as ?key=, but that form leaks it into every log sink.
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.gemini.apiKey,
      },
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
