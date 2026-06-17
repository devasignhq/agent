// Repo-scoped guidance materials (Workflow "Ingest context" node).
//
// A maintainer attaches a video link, a documentation link, or an uploaded PDF
// to a repository. We distil each one ONCE into concrete review guidelines —
// mirroring the indexer's "summarize, don't embed" approach — and store only
// that text on the Repository (no object storage, no raw PDF bytes). Every
// review then injects the distilled guidance via buildGuidanceSection().

import { lookup } from "node:dns/promises";
import net from "node:net";

import { db } from "../db.js";
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchGuardedPublic(url, controller.signal);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`fetch failed (HTTP ${res.status})`);

  const buf = await readCappedBytes(res, MAX_DOC_BYTES);
  const ctype = (res.headers.get("content-type") || "").toLowerCase();

  // A documentation link can itself point at a PDF — distil it the same way.
  if (ctype.includes("application/pdf") || isPdfBytes(buf)) {
    const summary = await extractGuidanceFromPdf({ base64: buf.toString("base64"), title });
    if (!summary) throw new Error("could not extract guidance from the linked PDF");
    return summary;
  }

  const text = htmlToText(buf.toString("utf8")).slice(0, 60_000);
  if (!text) throw new Error("the linked page had no readable text");
  const summary = await complete({
    system: GUIDANCE_EXTRACT_SYSTEM,
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

// Read a fetch body but stop (and abort) once it exceeds maxBytes, so a
// surprise multi-GB response can't blow up memory.
async function readCappedBytes(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("document is too large");
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

// Fetch a public URL, re-validating the SSRF guard on every redirect hop.
// `fetch(redirect:"follow")` would let a public host 3xx to a private/loopback/
// metadata address (e.g. 169.254.169.254) that fetch follows unchecked, so we
// follow manually and assertPublicUrl each Location before requesting it.
//
// Node's fetch (undici) exposes the real status + Location header under
// `redirect:"manual"` (unlike browsers, which opaque-filter them), which makes
// this possible. Note: assertPublicUrl resolves DNS and fetch resolves again,
// so a sub-second DNS-rebinding TOCTOU window remains per hop — acceptable here
// (authenticated Pro/Max-only input); closing it fully needs connection pinning.
async function fetchGuardedPublic(initialUrl: string, signal: AbortSignal): Promise<Response> {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": "devasign-guidance", Accept: "text/html,application/pdf,text/plain,*/*" },
    });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect with no location (HTTP ${res.status})`);
      // Resolve relative redirects against the URL we just requested, then loop
      // back to re-validate. Drain the redirect body so the socket can close.
      current = new URL(loc, current).toString();
      await res.body?.cancel().catch(() => {});
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

// SSRF guard: only fetch public http(s) hosts. Rejects non-http(s) schemes,
// obvious internal names, and any hostname that resolves to a private,
// loopback, link-local (incl. cloud metadata 169.254.169.254) or ULA address.
async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http(s) URLs are allowed");
  }
  const host = u.hostname;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("URL points at a private address");
    return;
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new Error("URL host is not public");
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("could not resolve host");
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("URL resolves to a private address");
  }
}

function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, ""); // unwrap IPv4-mapped IPv6
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  return false;
}
