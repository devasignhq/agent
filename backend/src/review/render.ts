// Shared markdown renderers for every DevAsign PR surface: the summary card, the
// per-item review-comment threads, and the consolidated fix prompt. Pure string
// building — no db / network / LLM — so it unit-tests offline. Moved verbatim out
// of pipeline.ts so comment.ts / items.ts can use it without importing the
// pipeline (which would cycle back through them).
import type { EvidenceCode, SuggestedChange } from "../types.js";
import type { HolisticFinding } from "./verdict-types.js";

// The reason a criterion failed (or a regressed one broke), for the verdict
// comment and the consolidated fix prompt. `evidence` is the review step's
// explanation; the prompt now requires it to be non-empty, but older records
// (and the rare blank result) would otherwise render a bare "not met" item with
// no "why". Fall back to a neutral sentence so the reader always gets a reason.
export function reasonOrFallback(evidence: string | null | undefined): string {
  const text = (evidence || "").trim();
  return text || "The current diff doesn't yet show this requirement being satisfied.";
}

// The "path/to/file.ts:42 — " location label for a finding: gutter-derived
// line number appended when the stage supplied one.
export function findingWhere(f: HolisticFinding): string {
  return f.path ? `\`${f.path}${f.line ? `:${f.line}` : ""}\` — ` : "";
}

// Structured before/after patch on a finding, indented to sit under its bullet.
export function appendFindingPatch(lines: string[], f: HolisticFinding) {
  if (!f.suggestedChange) return;
  lines.push("");
  appendPatchBlock(lines, f.suggestedChange, "  ");
}

// Defect findings render like holistic ones but carry two extra fields the
// generic renderer has no slot for: the bug class (as a leading tag) and the
// failure scenario (the thing that makes a finding actionable rather than an
// assertion). Kept separate rather than branching inside appendHolisticGroup so
// every other caller's output is byte-identical to before.
export function appendDefectGroup(lines: string[], findings: HolisticFinding[]) {
  if (!findings.length) return;
  for (const f of findings) {
    const sev =
      f.severity === "blocker" ? "**Blocker**" : f.severity === "nit" ? "Nit" : "Warn";
    const cls = f.defectClass ? `\`${f.defectClass}\` — ` : "";
    lines.push(`- ${sev} — ${findingWhere(f)}${cls}${f.concern}`);
    if (f.failureScenario) {
      lines.push(`  - **How it fails:** ${f.failureScenario}`);
    }
    appendFindingPatch(lines, f);
    appendFixPrompt(lines, f.fixPrompt, /* indented */ true);
  }
}

export function appendHolisticGroup(
  lines: string[],
  label: string,
  findings: HolisticFinding[]
) {
  if (!findings.length) return;
  lines.push(`#### ${label}`);
  for (const f of findings) {
    const sev = f.severity === "blocker" ? "**Blocker**" : f.severity === "nit" ? "Nit" : "Warn";
    lines.push(`- ${sev} — ${findingWhere(f)}${f.concern}`);
    appendFindingPatch(lines, f);
    appendFixPrompt(lines, f.fixPrompt, /* indented */ true);
  }
  lines.push("");
}

// Pick a code-fence backtick run strictly longer than the longest run of
// backticks already inside `content`. The fixPrompt template mandates an
// inner ```diff fence (see reviewDiff's system prompt), so a naive 3-backtick
// wrapper would be closed early by that inner fence — leaking the rest of the
// comment out as broken markdown. GitHub renders any fence of 3+ backticks;
// 4+ also keeps the one-click copy button. Minimum 3 so empty content still
// fences cleanly.
export function codeFence(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) || []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

// Validate an LLM-supplied code-fence language token. GitHub/Linguist apply
// syntax coloring only when the opening fence carries a language (typescript,
// ts, py, bash, json, diff…); a bare fence renders as uncolored monospace.
// Reject anything with whitespace/backticks/junk so a malformed value can't
// corrupt the fence info string; "" means "no language" (bare fence, unchanged
// behavior).
export function fenceLang(language?: string): string {
  const t = (language || "").trim().toLowerCase();
  return /^[a-z0-9+#.-]{1,20}$/.test(t) ? t : "";
}

// Push a fenced code block (opening fence tagged with the sanitized language so
// GitHub colors it, bare closing fence) onto a markdown line buffer. The fence
// length adapts to the content (codeFence) so inner backtick runs can't close
// it early; `pad` indents the whole block to sit under a list item. Mirrors the
// appendFixPrompt helper.
export function appendCodeBlock(lines: string[], code: string, language?: string, pad = "") {
  const fence = codeFence(code);
  lines.push(`${pad}${fence}${fenceLang(language)}`);
  for (const ln of code.split("\n")) lines.push(`${pad}${ln}`);
  lines.push(`${pad}${fence}`);
}

// Compose a structured before/after patch into a plain unified-diff-style
// snippet (removed lines "-", added lines "+", no hunk headers) for rendering
// inside a ```diff fence.
export function patchToDiff(p: SuggestedChange): string {
  const orig = p.original ? p.original.split("\n").map((l) => `-${l}`) : [];
  const sugg = p.suggested.split("\n").map((l) => `+${l}`);
  return [...orig, ...sugg].join("\n");
}

// Renders a structured suggestedChange as a labeled before/after diff block
// anchored to its file location.
export function appendPatchBlock(lines: string[], patch: SuggestedChange, pad = "") {
  lines.push(`${pad}**Suggested change** (\`${patch.path}:${patch.startLine}\`):`);
  lines.push("");
  appendCodeBlock(lines, patchToDiff(patch), "diff", pad);
  lines.push("");
}

// Renders a criterion's decisive evidence excerpt with its file anchor.
export function appendEvidenceBlock(lines: string[], ec: EvidenceCode, pad = "") {
  lines.push(`${pad}**Evidence** (\`${ec.path}:${ec.startLine}\`):`);
  lines.push("");
  appendCodeBlock(lines, ec.code, ec.language ?? undefined, pad);
  lines.push("");
}

// Renders the per-finding "prompt for your AI agent" block. The prompt sits in
// a fenced code block so GitHub's built-in copy button picks it up — no
// client-side wiring needed for the GitHub surface. The fence length adapts
// to the content (codeFence) so the fixPrompt's own ```diff hunk can't close
// the wrapper. The optional indent variant keeps list-rendered findings
// (holistic) readable; the 2-space pad aligns the block with the list item's
// content column so GitHub still parses it as belonging to the bullet.
export function appendFixPrompt(lines: string[], fixPrompt: string | undefined, indented = false) {
  if (!fixPrompt) return;
  const pad = indented ? "  " : "";
  const fence = codeFence(fixPrompt);
  lines.push("");
  lines.push(`${pad}**Prompt for your AI agent:**`);
  lines.push("");
  lines.push(`${pad}${fence}`);
  for (const ln of fixPrompt.split("\n")) lines.push(`${pad}${ln}`);
  lines.push(`${pad}${fence}`);
}
