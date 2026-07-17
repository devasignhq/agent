// Repo-scoped guidance materials (Workflow "Ingest context" node).
//
// A maintainer attaches a video link, a documentation link, or an uploaded PDF
// to a repository. We distil each one ONCE into concrete review guidelines —
// mirroring the indexer's "summarize, don't embed" approach — and store only
// that text on the Repository (no object storage, no raw PDF bytes). Every
// review then injects the distilled guidance via buildGuidanceSection().

import { db } from "../db.js";
import { fetchGuarded } from "../ssrf.js";
import type { RepoGuidanceItem, Repository } from "../types.js";
import {
  GUIDANCE_EXTRACT_SYSTEM,
  complete,
  extractGuidanceFromPdf,
  summarizeVideo,
} from "../llm.js";

// Hard cap on a fetched documentation page / PDF. Maintainer-provided docs are
// small; anything past this is almost certainly not a guidance doc.
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

// Run by the worker on a `guidance_ingest` job. Distils the material, then flips
// the item to ready/errored. Best-effort and fully self-contained: any failure
// marks the item errored rather than throwing past the worker.
export async function runGuidanceIngestJob(payload: {
  repoId: string;
  itemId: string;
  pdfBase64?: string;
  pdfMediaType?: string;
}): Promise<void> {
  const { repoId, itemId, pdfBase64 } = payload;
  const repo = db.find("repositories", (r) => r.id === repoId);
  if (!repo) return;
  const item = (repo.guidance ?? []).find((g) => g.id === itemId);
  if (!item) return;

  try {
    let summary: string | null = null;
    if (item.kind === "video") {
      summary = await guidanceFromVideo(item.url || "");
    } else if (item.kind === "pdf") {
      if (!pdfBase64) throw new Error("missing PDF data");
      summary = await extractGuidanceFromPdf({ base64: pdfBase64, title: item.title });
    } else {
      summary = await guidanceFromDoc(item.url || "", item.title);
    }
    if (!summary || !summary.trim()) throw new Error("no guidance could be extracted");
    patchGuidanceItem(repoId, itemId, {
      status: "ready",
      summary: summary.trim(),
      indexedAt: Date.now(),
      error: null,
    });
  } catch (err: any) {
    console.warn(`[guidance] ingest failed for ${repoId}/${itemId}:`, err);
    patchGuidanceItem(repoId, itemId, {
      status: "errored",
      error: String(err?.message || err).slice(0, 240),
    });
  }
}

// Assemble the ready guidance items into one authoritative block injected into
// the review's LLM stages. Empty string when the repo has no ready guidance.
export function buildGuidanceSection(repo: Repository): string {
  const ready = (repo.guidance ?? []).filter(
    (g) => g.status === "ready" && g.summary && g.summary.trim()
  );
  if (!ready.length) return "";
  const blocks = ready.map((g, i) => {
    const src = g.url ? ` (${g.url})` : "";
    return `### Guideline ${i + 1}: ${g.title}${src}\n${g.summary!.trim()}`;
  });
  return (
    "The repository maintainer attached the following review guidance materials. " +
    "Treat them as binding instructions for reviewing this pull request — enforce every applicable point.\n\n" +
    blocks.join("\n\n")
  );
}

// ── per-kind distillation ────────────────────────────────────────────────────

async function guidanceFromVideo(url: string): Promise<string> {
  if (!url) throw new Error("missing video URL");
  const v = await summarizeVideo({ url });
  const parts: string[] = [];
  if (v.summary && v.summary.trim()) parts.push(v.summary.trim());
  if (v.acceptanceSignals.length) {
    parts.push("Acceptance signals:\n" + v.acceptanceSignals.map((a) => `- ${a}`).join("\n"));
  }
  const text = parts.join("\n\n").trim();
  if (!text) throw new Error("video could not be summarized");
  return text;
}

async function guidanceFromDoc(url: string, title: string): Promise<string> {
  if (!url) throw new Error("missing document URL");

  // Absolute deadline over the WHOLE fetch (connect + headers + every redirect
  // hop + body read). req.setTimeout alone is only a per-socket *idle* timeout,
  // which a slow-drip server resets forever (Slowloris) — and the worker drains
  // serially, so one stalled fetch would block all reviews. The AbortSignal caps it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let result: { buf: Buffer; contentType: string };
  try {
    result = await fetchGuardedDoc(url, controller.signal);
  } finally {
    clearTimeout(timer);
  }
  const { buf, contentType } = result;

  // A documentation link can itself point at a PDF — distil it the same way.
  if (contentType.includes("application/pdf") || isPdfBytes(buf)) {
    const summary = await extractGuidanceFromPdf({ base64: buf.toString("base64"), title });
    if (!summary) throw new Error("could not extract guidance from the linked PDF");
    return summary;
  }

  const text = htmlToText(buf.toString("utf8")).slice(0, 60_000);
  if (!text) throw new Error("the linked page had no readable text");
  const summary = await complete({
    system: GUIDANCE_EXTRACT_SYSTEM,
    cacheSystem: true, // static system prompt (DEVASIGN.md convention)
    maxTokens: 1024,
    messages: [{ role: "user", content: `Document title: ${title}\nSource URL: ${url}\n\n${text}` }],
  });
  if (!summary || !summary.trim()) throw new Error("could not extract guidance from the linked page");
  return summary;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function patchGuidanceItem(
  repoId: string,
  itemId: string,
  patch: Partial<RepoGuidanceItem>
): void {
  const repo = db.find("repositories", (r) => r.id === repoId);
  if (!repo) return;
  const guidance = (repo.guidance ?? []).map((g) => (g.id === itemId ? { ...g, ...patch } : g));
  db.update("repositories", (r) => r.id === repoId, { guidance });
}

// Lightweight HTML → text. No new dependency: drop scripts/styles/comments and
// tags, decode the few entities that matter, collapse whitespace.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isPdfBytes(buf: Buffer): boolean {
  return buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-";
}

// Fetch a documentation URL behind the shared SSRF guard (ssrf.ts): every
// redirect hop is re-validated and each socket is pinned to the addresses just
// checked, so neither a redirect to a private/metadata address nor a DNS-rebind
// between validation and connect can reach it. The doc-specific bits — the size
// cap, the Accept headers — stay here; the security lives in ssrf.ts.
const DOC_HEADERS = {
  "User-Agent": "devasign-guidance",
  Accept: "text/html,application/pdf,text/plain,*/*",
};

async function fetchGuardedDoc(
  initialUrl: string,
  signal: AbortSignal
): Promise<{ buf: Buffer; contentType: string }> {
  return fetchGuarded(initialUrl, {
    signal,
    maxBytes: MAX_DOC_BYTES,
    maxRedirects: MAX_REDIRECTS,
    headersFor: () => DOC_HEADERS,
  });
}

// The SSRF guard moved to ssrf.ts so the Linear attachment path could share it
// rather than reinvent it. Re-exported to keep this module's public surface
// unchanged — guidance.test.ts drives the doc pipeline through these.
export { pinnedLookup, resolvePublicUrl } from "../ssrf.js";
export { __setGuardedTransportForTests as __setDocTransportForTests } from "../ssrf.js";
