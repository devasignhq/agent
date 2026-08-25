// The cross-repo stage: pre-scan the diff, extract a contract delta, find
// sibling code that consumes it, and ask the model what actually breaks.
//
// Advisory by construction. Severity is forced at normalisation, so nothing this
// module returns can reach the merge gate even if a future edit wires it in.
import { complete } from "../../llm.js";
import { UNTRUSTED_DIRECTIVE, boundaryNotice, newBoundaryToken, wrapUntrusted } from "../../untrusted.js";
import { contractDeltaSystemPrompt, crossRepoSystemPrompt } from "../prompts.js";
import { withMaintainerInstructions } from "../decisions.js";
import { needlesFor, type CandidateSnippet, type Needle, type ParityProbe } from "./discovery.js";
// The probe map is keyed by this slug and the model echoes a slug of its own;
// both sides go through slugify so a spelling difference cannot discard a note.
import { slugify } from "./naming.js";
import type { HolisticFinding } from "../pipeline.js";

export const MAX_IMPACT_FINDINGS = 5;
export const MAX_PARITY_NOTES = 3;
export const CROSS_REPO_BUDGET_MS = 45_000;
const CONTRACT_DIFF_CAP = 60_000;
export const CONTRACT_DELTA_MODEL = "claude-haiku-4-5";

export type ContractSurface =
  | "ts-export" | "go-export" | "py-export" | "rust-export" | "http" | "graphql" | "proto"
  | "event" | "cli" | "env" | "config" | "error-code" | "db-schema" | "contract-abi";

export type ContractChange =
  | "added" | "removed" | "renamed" | "signature_changed" | "semantics_changed" | "deprecated";

export type ContractCompat = "compatible" | "breaking" | "behavioral";

export type ContractDeltaEntry = {
  surface: ContractSurface;
  name: string;
  change: ContractChange;
  detail: string;
  compat: ContractCompat;
  path: string;
  line?: number;
};

const SURFACES = new Set<string>([
  "ts-export", "go-export", "py-export", "rust-export", "http", "graphql", "proto",
  "event", "cli", "env", "config", "error-code", "db-schema", "contract-abi",
]);
const CHANGES = new Set<string>([
  "added", "removed", "renamed", "signature_changed", "semantics_changed", "deprecated",
]);
const COMPATS = new Set<string>(["compatible", "breaking", "behavioral"]);

// Cheap regex gate. Most PRs touch no external surface at all and stop here,
// which is what makes the stage affordable enough to run on every review.
const SURFACE_PATTERNS: RegExp[] = [
  /^[+-]\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\b/m,
  /^[+-]\s*export\s*\{/m,
  /^[+-]\s*func\s+[A-Z]\w*\s*\(/m,
  /^[+-]\s*(?:pub\s+(?:fn|struct|enum|trait))\b/m,
  /^[+-]\s*def\s+[a-z_]\w*\s*\(/m,
  /^[+-].*\b(?:router|app|server)\.(?:get|post|put|patch|delete|use)\s*\(\s*["'`]\//m,
  /^[+-].*@(?:app|bp|router)\.(?:route|get|post|put|patch|delete)\s*\(/m,
  /^[+-].*\bprocess\.env\.[A-Z_][A-Z0-9_]*/m,
  /^[+-].*\bos\.environ(?:\.get)?\[?["'][A-Z_][A-Z0-9_]*/m,
];

const SURFACE_PATHS =
  /(?:\.proto|\.graphql|openapi\.(?:ya?ml|json)|schema\.graphql|\.sol|contracts?\/|migrations?\/)/i;

export function scanContractCandidates(diff: string): string[] {
  if (!diff) return [];
  const hits = new Set<string>();
  for (const block of diff.split(/^diff --git /m)) {
    if (!block.trim()) continue;
    const pathMatch = block.match(/^a\/(\S+)\s+b\/(\S+)/);
    const path = pathMatch ? pathMatch[2] : "";
    if (path && SURFACE_PATHS.test(path)) {
      hits.add(path);
      continue;
    }
    if (SURFACE_PATTERNS.some((re) => re.test(block))) hits.add(path || "(unknown)");
  }
  return [...hits];
}

function coerceEntry(v: unknown): ContractDeltaEntry | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  const surface = String(o.surface || "");
  const change = String(o.change || "");
  const compat = String(o.compat || "");
  if (!SURFACES.has(surface) || !CHANGES.has(change) || !COMPATS.has(compat)) return null;
  return {
    surface: surface as ContractSurface,
    name,
    change: change as ContractChange,
    detail: typeof o.detail === "string" ? o.detail : "",
    compat: compat as ContractCompat,
    path: typeof o.path === "string" ? o.path : "",
    line: typeof o.line === "number" && o.line > 0 ? o.line : undefined,
  };
}

export function normaliseContractDelta(raw: unknown): ContractDeltaEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ContractDeltaEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const e = coerceEntry(item);
    if (!e) continue;
    const key = `${e.surface}|${e.name}|${e.change}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.slice(0, 40);
}

export function needlesForDelta(entries: ContractDeltaEntry[]): Needle[] {
  const out: Needle[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.compat === "compatible") continue;
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    const n = needlesFor(e.name, e.surface === "http" ? "route" : "symbol");
    if (n.variants.length) out.push(n);
  }
  return out;
}

export async function extractContractDelta(args: {
  diff: string;
  candidates: string[];
}): Promise<ContractDeltaEntry[]> {
  const diff = args.diff.length > CONTRACT_DIFF_CAP ? args.diff.slice(0, CONTRACT_DIFF_CAP) : args.diff;
  const token = newBoundaryToken();
  const userText =
    `${boundaryNotice(token)}\n\n` +
    `# Files with a possible external surface\n${args.candidates.join("\n") || "(none)"}\n\n` +
    `# Diff\n${wrapUntrusted("DIFF", diff, token)}`;
  const raw = await complete({
    system: contractDeltaSystemPrompt() + UNTRUSTED_DIRECTIVE,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 3072,
    // Pinned: runReviewJob wraps the job in withModel(frontier) for Pro/Max — the
    // only tiers that reach this stage — so without it every pre-scan hit would
    // pay an Opus call to do extraction from a diff already in front of it.
    model: CONTRACT_DELTA_MODEL,
  });
  const parsed = tryParse<{ entries?: unknown }>(raw);
  return normaliseContractDelta(parsed.entries);
}

function tryParse<T>(raw: string): T {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? (JSON.parse(m[0]) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

export type CrossRepoResult = {
  impacts: HolisticFinding[];
  parityNotes: HolisticFinding[];
  parityFeatures: Array<{ slug: string; title: string; missingIn: string[]; searched: string }>;
  family?: string;
  summary: string;
};

export const EMPTY_CROSS_REPO: CrossRepoResult = {
  impacts: [],
  parityNotes: [],
  parityFeatures: [],
  summary: "",
};



// `where` is qualified as "owner/repo:path" on purpose: findingWhere() renders
// a finding's path bare, as if it belonged to the reviewed repo.
function qualify(where: string): string {
  return where.replace(/\s+/g, "");
}

// Indentation and wrapping differ between what the model echoes and the file it
// read; content does not. Compared squashed so reformatting is not a drop, while
// composed text still fails.
function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Takes the snippets themselves rather than a set of repo names, so the "is this
// repo known" and "is this line real" checks cannot drift apart: both are decided
// from the same byte-confirmed excerpts. There is no default — a caller that
// passes nothing gets nothing through, never a silently skipped check.
export function normaliseImpacts(
  raw: unknown,
  snippets: CandidateSnippet[]
): HolisticFinding[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: HolisticFinding[] = [];
  const seen = new Set<string>();
  const bySquashedRepo = new Map<string, string[]>();
  for (const s of snippets) {
    bySquashedRepo.set(s.repoFullName, [
      ...(bySquashedRepo.get(s.repoFullName) || []),
      squash(s.excerpt),
    ]);
  }
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const where = typeof o.where === "string" ? qualify(o.where) : "";
    const concern = typeof o.concern === "string" ? o.concern.trim() : "";
    const evidence = typeof o.evidence === "string" ? o.evidence.trim() : "";
    const failureScenario = typeof o.failureScenario === "string" ? o.failureScenario.trim() : "";
    // The drop rule: no quoted consuming line means the model is speculating.
    if (!where || !concern || !evidence) continue;
    // The quoted line must OCCUR in bytes we actually read from that sibling.
    // Checking only that the repo was read let a real repo carry a composed
    // line — which is the claim this whole stage rests on not being possible.
    const repoPart = where.split(":")[0];
    const excerpts = bySquashedRepo.get(repoPart);
    if (!excerpts) continue;
    const needle = squash(evidence);
    if (!needle || !excerpts.some((e) => e.includes(needle))) continue;
    if (seen.has(where + concern.slice(0, 60))) continue;
    seen.add(where + concern.slice(0, 60));
    out.push({
      path: where,
      line: typeof o.line === "number" && o.line > 0 ? o.line : undefined,
      concern: `${concern}\n\nConsuming line: \`${evidence.slice(0, 300)}\``,
      severity: "warn", // forced: this stage is advisory and must stay unable to block
      ...(failureScenario ? { failureScenario } : {}),
    });
  }
  return out.slice(0, MAX_IMPACT_FINDINGS);
}

export function normaliseParityNotes(
  raw: unknown,
  probes: Map<string, ParityProbe[]>
): { notes: HolisticFinding[]; features: CrossRepoResult["parityFeatures"] } {
  const list = Array.isArray(raw) ? raw : [];
  const notes: HolisticFinding[] = [];
  const features: CrossRepoResult["parityFeatures"] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const slug = typeof o.featureSlug === "string" ? o.featureSlug.trim() : "";
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const searched = typeof o.searched === "string" ? o.searched.trim() : "";
    const concern = typeof o.concern === "string" ? o.concern.trim() : "";
    const missingIn = Array.isArray(o.missingIn) ? o.missingIn.filter((r) => typeof r === "string") : [];
    // Never claim absence without saying what was looked for, and never over a
    // repo we could not read: probeParity marks those "unknown", not "absent".
    if (!slug || !title || !searched || !missingIn.length) continue;
    const key = slugify(slug);
    const forFeature =
      probes.get(slug) ||
      [...probes.entries()].find(([k]) => slugify(k) === key)?.[1] ||
      [];
    const confirmed = missingIn.filter(
      (repo) => forFeature.find((p) => p.repoFullName === repo)?.status === "absent"
    );
    if (!confirmed.length) continue;
    features.push({ slug: key, title, missingIn: confirmed, searched });
    notes.push({
      path: confirmed[0],
      concern:
        `${title}\n\n${concern}\n\nMissing in: ${confirmed.join(", ")}.\nSearched: ${searched}`,
      severity: "nit", // forced: parity is a heads-up, never a finding
    });
  }
  return { notes: notes.slice(0, MAX_PARITY_NOTES), features: features.slice(0, MAX_PARITY_NOTES) };
}

export async function assessCrossRepoImpact(args: {
  delta: ContractDeltaEntry[];
  snippets: CandidateSnippet[];
  parityProbes: Map<string, ParityProbe[]>;
  familyMembers: string[];
  selfFullName: string;
  extraInstructions?: string;
}): Promise<CrossRepoResult> {
  const token = newBoundaryToken();
  const deltaBlock = args.delta
    .map((e) => `- [${e.compat}] ${e.surface} \`${e.name}\` ${e.change} — ${e.detail} (${e.path}${e.line ? `:${e.line}` : ""})`)
    .join("\n");

  const snippetBlock = args.snippets
    .map(
      (s) =>
        `### ${s.repoFullName}:${s.path} (line ${s.line}, matched "${s.matchedOn}", via ${s.lane})\n` +
        wrapUntrusted("SIBLING_FILE", s.excerpt, token)
    )
    .join("\n\n");

  const parityBlock = [...args.parityProbes.entries()]
    .map(([feature, probes]) =>
      `### ${feature}\n` +
      probes.map((p) => `- ${p.repoFullName}: ${p.status} (searched ${p.searched})`).join("\n")
    )
    .join("\n\n");

  const userText =
    `${boundaryNotice(token)}\n\n` +
    `# This repository\n${args.selfFullName}\n\n` +
    `# Family members\n${args.familyMembers.join("\n") || "(none detected)"}\n\n` +
    `# Contract delta for this change\n${deltaBlock || "(none)"}\n\n` +
    `# Sibling code that mentions the changed surfaces\n${snippetBlock || "(no sibling code found)"}\n\n` +
    `# Parity probes (what was searched in each sibling)\n${parityBlock || "(none run)"}`;

  const raw = await complete({
    system: withMaintainerInstructions(crossRepoSystemPrompt(), args.extraInstructions) + UNTRUSTED_DIRECTIVE,
    cacheSystem: true,
    messages: [{ role: "user", content: userText }],
    maxTokens: 3072,
  });
  const parsed = tryParse<{ impacts?: unknown; parityNotes?: unknown; summary?: unknown }>(raw);
  const parity = normaliseParityNotes(parsed.parityNotes, args.parityProbes);
  return {
    impacts: normaliseImpacts(parsed.impacts, args.snippets),
    parityNotes: parity.notes,
    parityFeatures: parity.features,
    summary: String(parsed.summary || ""),
  };
}
