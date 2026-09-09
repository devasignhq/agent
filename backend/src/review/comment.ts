// Every piece of markdown DevAsign writes onto a pull request: the summary card
// (the editable conversation comment) and the body of each inline review-comment
// thread. Pure — no db / network / LLM:
//   node --import tsx/esm --test src/review/summary-card.test.ts
//   node --import tsx/esm --test src/review/thread-body.test.ts
//
// Icons here are OUR chrome, and deliberate: the card has to be scannable at a
// glance. Model-authored prose stays emoji-free (every stage prompt still ends
// with "Never use emoji in any text you output").
import type { Chippable, ReviewItem, ReviewItemCategory } from "./items.js";
import {
  appendCodeBlock,
  appendEvidenceBlock,
  appendPatchBlock,
  codeFence,
  reasonOrFallback,
} from "./render.js";
import { countByChip } from "./items.js";
import { scoreHeader } from "./score.js";

export const CARD_TITLE = "## DevAsign Code Review";
export const TESTS_TITLE = "## Tests by DevAsign";

// ─── Item markers ───────────────────────────────────────────────────────────
// Every thread body opens with a hidden marker naming the item it belongs to, so
// the thread set can be rebuilt from GitHub if the stored state is ever lost. The
// key is base64url-encoded: it can then never contain "-->" or a newline, no
// matter what path or wording produced it.

const MARKER_RE = /^<!-- devasign:item v1 k=([A-Za-z0-9_-]+) -->$/m;
const RESOLVED_RE = /^<!-- devasign:resolved sha=([0-9a-f]+) -->$/m;

export function itemMarker(key: string): string {
  return `<!-- devasign:item v1 k=${Buffer.from(key, "utf8").toString("base64url")} -->`;
}

export function parseItemMarker(body: string): string | null {
  const m = MARKER_RE.exec(body || "");
  if (!m) return null;
  try {
    return Buffer.from(m[1], "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

/** The sha a thread was marked fixed at, or null while it is still open. */
export function parseResolvedMarker(body: string): string | null {
  return RESOLVED_RE.exec(body || "")?.[1] ?? null;
}

// ─── Thread bodies ──────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<ReviewItemCategory, { icon: string; label: string }> = {
  criterion: { icon: "📋", label: "Acceptance criterion" },
  regression: { icon: "🐞", label: "Regression" },
  criticalError: { icon: "🐞", label: "Critical error" },
  defect: { icon: "🐞", label: "Bug" },
  security: { icon: "🔒", label: "Security" },
  commitIntent: { icon: "🧭", label: "Intent" },
  deferral: { icon: "🚧", label: "Deferred work" },
  convention: { icon: "📝", label: "Convention" },
  docDrift: { icon: "📝", label: "Docs" },
  crossRepo: { icon: "🔗", label: "Cross-repo" },
  parity: { icon: "🔗", label: "Feature parity" },
  lineNote: { icon: "📝", label: "Note" },
};

function criterionHeading(item: ReviewItem): string {
  // Synthesized ids are plain numbers ("1", "2"), which read as a dangling digit
  // after an em dash; "#2" reads as a reference. Ids that already look like
  // labels ("C2", "AC-3") are left alone.
  const label = /^\d+$/.test(item.criterionId ?? "") ? `#${item.criterionId}` : item.criterionId;
  const id = item.criterionId ? ` — ${label}` : "";
  if (item.state === "met") return `### ✅ Acceptance criterion met${id}`;
  if (item.scoreKind === "criterion-regressed") {
    return `### ⚠️ Acceptance criterion regressed${id}`;
  }
  if (item.scoreKind === "criterion-unevaluated") {
    return `### 📋 Acceptance criterion could not be evaluated${id}`;
  }
  return `### 📋 Acceptance criterion not met${id}`;
}

function heading(item: ReviewItem): string {
  if (item.category === "criterion") return criterionHeading(item);
  const { icon, label } = CATEGORY_LABEL[item.category];
  // Security findings show their 4-tier severity; everything else shows the
  // coarse one — either way it belongs in the heading, next to what it is about,
  // rather than on a line that repeats the concern the heading already carries.
  const tier = item.securitySeverity ?? (item.severity === "warn" ? null : item.severity);
  return `### ${icon} ${label}${tier ? ` (${tier})` : ""} — ${item.title}`;
}

export type ThreadBodyOpts = {
  // A rendered "Fixed in `abc1234`" line, for an item that is still reported but
  // has just flipped to satisfied — a criterion that now passes keeps its thread
  // (the reader wants to see it pass) and should still name the commit.
  fixedIn?: string | null;
  // Set when the anchor was snapped to the nearest line actually in the diff, so
  // the body can say where the finding really points.
  snappedFrom?: number;
  // Set when a later push moved the code: GitHub renders the thread "outdated"
  // and its line goes stale, so we link the live location instead.
  relocatedTo?: { path: string; line?: number; url: string };
  // Re-opened after having been marked fixed.
  reopened?: boolean;
};

// <summary> on the same line as its tag is an HTML block, so a title containing
// "<Props>" would be swallowed as markup. Escape it; markdown is inert there anyway.
function escapeSummary(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function summaryText(item: ReviewItem): string {
  return escapeSummary(heading(item).replace(/^### /, ""));
}

function openCollapsed(lines: string[], summary: string) {
  lines.push("<details>", `<summary>${summary}</summary>`, "");
}

// Every thread body is one collapsed block: marker, then <details> whose summary
// is the heading. Threads render expanded in GitHub's timeline otherwise.
export function formatThreadBody(item: ReviewItem, opts: ThreadBodyOpts = {}): string {
  const lines: string[] = [itemMarker(item.key)];
  openCollapsed(lines, summaryText(item));

  if (opts.reopened) {
    lines.push("**Reopened** — this came back in the latest review.", "");
  }
  if (opts.fixedIn) {
    lines.push(opts.fixedIn, "");
  }
  // resolveAnchor only sets snappedFrom when it actually moved the anchor, so
  // its presence is the whole condition — the item still carries the line the
  // model gave, which is exactly the number worth naming here.
  if (opts.snappedFrom) {
    lines.push(`_Nearest diff line to \`${item.path}:${opts.snappedFrom}\`._`, "");
  }
  if (opts.relocatedTo) {
    const where = `${opts.relocatedTo.path}${opts.relocatedTo.line ? `:${opts.relocatedTo.line}` : ""}`;
    lines.push(`_Now at_ [\`${where}\`](${opts.relocatedTo.url})`, "");
  }

  if (item.category === "criterion") {
    lines.push(`**Required:** ${item.criterionText ?? item.concern}`, "");
    if (item.state === "met") {
      // "Evidence" is already the label on the code excerpt below; this is the
      // reviewer's prose, so it needs its own name.
      if (item.reason) lines.push(`**How it's satisfied:** ${item.reason}`, "");
    } else if (item.scoreKind === "criterion-unevaluated") {
      lines.push(
        `**Why:** ${
          (item.reason || "").trim() ||
          "The reviewer could not evaluate this requirement against the diff (no verdict was returned for it)."
        }`,
        ""
      );
    } else if (item.scoreKind === "criterion-regressed") {
      lines.push(`**What broke:** ${reasonOrFallback(item.reason)}`, "");
    } else {
      lines.push(`**Why it isn't met:** ${reasonOrFallback(item.reason)}`, "");
    }
  } else {
    // The heading already carries the title and severity. Repeat the concern only
    // when the title is a truncation of it, so nothing is lost.
    if (item.concern.trim() !== item.title) lines.push(item.concern, "");
    if (item.defectClass) lines.push(`**Class:** \`${item.defectClass}\``, "");
    if (item.failureScenario) lines.push(`**How it fails:** ${item.failureScenario}`, "");
  }

  if (item.evidenceCode) appendEvidenceBlock(lines, item.evidenceCode);
  if (item.suggestedChange) appendPatchBlock(lines, item.suggestedChange);

  // Legacy suggestion renderings the review pass can still emit for a criterion.
  for (const s of item.suggestions ?? []) {
    const samePatch =
      s.patch &&
      item.suggestedChange &&
      s.patch.path === item.suggestedChange.path &&
      s.patch.suggested === item.suggestedChange.suggested;
    if (s.patch && !samePatch) {
      appendPatchBlock(lines, s.patch);
    } else if (s.suggestedChange) {
      lines.push("**Suggested change:**", "");
      // Hard-code the diff language tag — the LLM's `language` field describes
      // `codeExample`, not this snippet.
      appendCodeBlock(lines, s.suggestedChange, "diff");
      lines.push("");
    }
    if (s.codeExample) {
      lines.push("**Full code:**", "");
      appendCodeBlock(lines, s.codeExample, s.language);
      lines.push("");
    }
  }

  appendPromptDetails(lines, item.fixPrompt, FIX_PROMPT_SUMMARY);
  lines.push("", "</details>");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const FIX_PROMPT_SUMMARY = "Prompt to fix with AI";

// Drop the marker and the outer collapsed wrapper, leaving the detail. Bodies
// written before the wrapper existed come back unchanged.
export function unwrapThreadBody(body: string): string {
  const lines = body.replace(MARKER_RE, "").trim().split("\n");
  const wrapped =
    lines.length >= 3 &&
    lines[0].trim() === "<details>" &&
    lines[1].trim().startsWith("<summary>") &&
    lines[lines.length - 1].trim() === "</details>";
  if (!wrapped) return lines.join("\n").trim();
  return lines.slice(2, -1).join("\n").trim();
}

// Remove the collapsed fix-prompt block from a thread body. Used when a thread is
// marked fixed: the original detail is worth keeping for reference, but a prompt
// telling the reader how to fix something that is already fixed is just noise —
// and the one place it could still be acted on (a reopened thread) re-renders
// from the item anyway.
//
// Walks lines instead of matching a regex: the prompt is fenced code and may
// legitimately contain the text "</details>", which a non-greedy match would
// stop at, orphaning the real closing tag.
export function stripFixPromptBlock(body: string): string {
  const lines = body.split("\n");
  const summaryAt = lines.findIndex((l) => l.trim() === `<summary>${FIX_PROMPT_SUMMARY}</summary>`);
  if (summaryAt < 1 || lines[summaryAt - 1].trim() !== "<details>") return body;
  const start = summaryAt - 1;

  let depth = 0;
  let fence: number | null = null;
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    const m = /^(`{3,})(.*)$/.exec(lines[i]);
    if (m) {
      const ticks = m[1].length;
      const info = m[2].trim();
      if (fence === null) {
        fence = ticks;
        continue;
      }
      if (info === "" && ticks >= fence) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue; // literal text inside the prompt, not markup
    if (lines[i].includes("<details>")) depth++;
    if (lines[i].includes("</details>")) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return body; // malformed — leave it alone rather than truncate
  lines.splice(start, end - start + 1);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The thread body once the item stops being reported. The original detail is
// kept, collapsed, so the reader can still see what the finding was.
export function formatResolvedThreadBody(args: {
  item: { key: string; title: string; category: ReviewItemCategory };
  openBody: string;
  sha: string;
  // How the fix was located. "commit" names the single commit in the delta,
  // "range" spans several, "head" is the fallback when nothing else is known,
  // and "gone" means the file left the PR entirely.
  attribution:
    | { kind: "commit"; sha: string; url: string; message?: string }
    | { kind: "range"; base: string; head: string; url: string; count: number }
    | { kind: "head"; sha: string; url: string }
    | { kind: "gone"; path: string; sha: string; url: string };
}): string {
  const { item, openBody, sha, attribution } = args;
  const short = sha.slice(0, 7);
  const lines: string[] = [itemMarker(item.key), `<!-- devasign:resolved sha=${short} -->`];

  if (attribution.kind === "gone") {
    openCollapsed(lines, escapeSummary(`✅ No longer in this PR — ${item.title}`));
    lines.push(
      `\`${attribution.path}\` is no longer part of this pull request's changes as of ` +
        `[\`${attribution.sha.slice(0, 7)}\`](${attribution.url}), so this finding no longer applies.`
    );
  } else {
    openCollapsed(lines, escapeSummary(`✅ Fixed — ${item.title}`));
    lines.push(`This no longer appears in the review of \`${short}\`.`);
  }

  const where = attributionLine(attribution);
  if (where) lines.push("", where);

  // The original detail stays for reference, minus its marker (one per body)
  // and its fix prompt — there is nothing left to fix.
  lines.push("", "**What this was**", "", stripFixPromptBlock(unwrapThreadBody(openBody)), "", "</details>");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function attributionLine(
  a: Parameters<typeof formatResolvedThreadBody>[0]["attribution"]
): string | null {
  switch (a.kind) {
    case "commit":
      return (
        `Fixed in [\`${a.sha.slice(0, 7)}\`](${a.url})` +
        (a.message ? ` — _"${a.message}"_.` : ".")
      );
    case "range":
      return (
        `Fixed somewhere in [\`${a.base.slice(0, 7)}…${a.head.slice(0, 7)}\`](${a.url}) — ` +
        `${a.count} commit${a.count === 1 ? "" : "s"} since the last review.`
      );
    case "head":
      return (
        `Fixed as of [\`${a.sha.slice(0, 7)}\`](${a.url}), the last commit reviewed. ` +
        `DevAsign couldn't determine which commit resolved it.`
      );
    case "gone":
      return null;
  }
}

// ─── The summary card ───────────────────────────────────────────────────────

function appendPromptDetails(lines: string[], prompt: string | null | undefined, summary: string) {
  if (!prompt) return;
  const fence = codeFence(prompt);
  lines.push("", "<details>", `<summary>${summary}</summary>`, "", fence, prompt, fence, "", "</details>");
}

export function formatChips(open: Chippable[], fixedCount = 0): string {
  const chips = countByChip(open)
    .filter((c) => c.count > 0)
    .map((c) => `${c.icon} \`${c.label} (${c.count})\``);
  // Nothing open still deserves a chip — "clean" is the most useful thing the
  // card can say, and it must not be crowded out by the fixed-count chip.
  if (!chips.length) chips.push("✅ `No issues found`");
  if (fixedCount > 0) chips.push(`✅ \`Fixed since last review (${fixedCount})\``);
  return chips.join(" · ");
}

const SUMMARY_LINE_CAP = 2;
const SUMMARY_CHAR_CAP = 300;

// At most three lines: one deterministic line of criteria arithmetic (what was
// asked for), then up to two lines of the reviewer's own summary.
export function summaryLines(args: {
  specless: boolean;
  criteriaTotal: number;
  criteriaMet: number;
  summary: string;
}): string[] {
  const lines: string[] = [];
  if (args.specless) {
    lines.push(
      "This PR has no linked issue or spec, so no acceptance criteria were checked — it was reviewed for correctness only."
    );
  } else {
    const notMet = args.criteriaTotal - args.criteriaMet;
    lines.push(
      `${args.criteriaMet} of ${args.criteriaTotal} acceptance criteria met` +
        (notMet > 0 ? `, ${notMet} not met.` : ".")
    );
  }
  const prose = (args.summary || "").trim().replace(/\s+/g, " ");
  if (prose) {
    const sentences = prose.match(/[^.!?]+[.!?]*/g) ?? [prose];
    let out = "";
    for (const s of sentences.slice(0, SUMMARY_LINE_CAP)) {
      if (out.length + s.length > SUMMARY_CHAR_CAP) break;
      out += s;
    }
    out = out.trim() || prose.slice(0, SUMMARY_CHAR_CAP).trim();
    if (out) lines.push(out);
  }
  return lines;
}

function appendItemList(lines: string[], summary: string, items: ReviewItem[]) {
  if (!items.length) return;
  lines.push("", "<details>", `<summary>${summary} (${items.length})</summary>`, "");
  for (const i of items) {
    const where = i.path ? `\`${i.path}${i.line ? `:${i.line}` : ""}\` — ` : "";
    const tag = CATEGORY_LABEL[i.category].label;
    lines.push(`- **${tag}** — ${where}${i.title}`);
  }
  lines.push("", "</details>");
}

export function formatSummaryCard(args: {
  open: Chippable[];
  fixedCount: number;
  score: number;
  specless: boolean;
  criteriaTotal: number;
  criteriaMet: number;
  summary: string;
  // The consolidated "fix everything in one paste" prompt, built by the pipeline.
  fixPrompt?: string | null;
  // Items that never made it onto a thread, so the card is still complete.
  unanchored?: ReviewItem[];
  overflow?: ReviewItem[];
  metWithoutThread?: ReviewItem[];
  // Trailing pointers: pre-existing security, the tests comment, the end-goal CTA.
  notes?: string[];
  cta?: string | null;
}): string {
  const lines: string[] = [CARD_TITLE, "", formatChips(args.open, args.fixedCount), ""];
  lines.push(scoreHeader(args.score), "");
  lines.push(
    ...summaryLines({
      specless: args.specless,
      criteriaTotal: args.criteriaTotal,
      criteriaMet: args.criteriaMet,
      summary: args.summary,
    })
  );

  appendPromptDetails(lines, args.fixPrompt, "Prompt to fix all issues");
  // Satisfied criteria have one home on the card — the "Met criteria" list —
  // whichever reason kept them off a thread. Without this they'd appear there
  // AND under "Other findings", which reads as two different results.
  const stillOpen = (list?: ReviewItem[]) => (list ?? []).filter((i) => i.state === "open");
  appendItemList(lines, "Other findings — not anchored to the diff", stillOpen(args.unanchored));
  appendItemList(lines, "Not shown inline", stillOpen(args.overflow));
  appendItemList(lines, "Met criteria", args.metWithoutThread ?? []);

  for (const note of args.notes ?? []) if (note) lines.push("", note);
  if (args.cta) lines.push("", args.cta);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
