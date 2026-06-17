// Repo-scoped guidance materials (Workflow "Ingest context" node).
//
// A maintainer attaches a video link, a documentation link, or an uploaded PDF
// to a repository. We distil each one ONCE into concrete review guidelines —
// mirroring the indexer's "summarize, don't embed" approach — and store only
// that text on the Repository (no object storage, no raw PDF bytes). Every
// review then injects the distilled guidance via buildGuidanceSection().

import { lookup } from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";

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

  const { buf, contentType } = await fetchGuardedDoc(url);

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

type PinnedAddr = { address: string; family: number };
type DocResult = { status: number; location: string | null; contentType: string; body: Buffer };
// One request to an already-validated, IP-pinned host. Overridable for tests.
type DocTransport = (url: URL, addrs: PinnedAddr[]) => Promise<DocResult>;

// Fetch a documentation URL behind the SSRF guard, following redirects manually
// and re-validating every hop. The decisive anti-SSRF control is that each hop
// resolves+validates the host ONCE and then pins the socket to exactly those
// IPs (see nodeHttpTransport), so neither a redirect to a private/metadata
// address nor a DNS-rebind between validation and connect can reach it.
async function fetchGuardedDoc(initialUrl: string): Promise<{ buf: Buffer; contentType: string }> {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, addrs } = await resolvePublicUrl(current);
    const res = await docTransport(url, addrs);
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      if (!res.location) throw new Error(`redirect with no location (HTTP ${res.status})`);
      // Resolve relative redirects against the URL we just requested, then loop
      // back so the new host is itself validated + pinned before we connect.
      current = new URL(res.location, url).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`fetch failed (HTTP ${res.status})`);
    return { buf: res.body, contentType: res.contentType };
  }
  throw new Error("too many redirects");
}

// Lock a connection's DNS resolution to the pre-validated addresses, so the
// socket cannot be steered to a different (private) IP than the one we checked.
// Matches the net.connect `lookup` contract (dns.lookup-style, with `all`).
export function pinnedLookup(addrs: PinnedAddr[]) {
  return (_hostname: string, options: any, cb: any) => {
    if (options && options.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  };
}

// The real transport: a GET over node:http/https, pinned to `addrs` via the
// `lookup` option (so there is no second DNS resolution to rebind), with SNI +
// cert validation still keyed off the URL hostname. `Accept-Encoding: identity`
// keeps the body uncompressed so we can read it without a decompressor.
const nodeHttpTransport: DocTransport = (url, addrs) =>
  new Promise<DocResult>((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(addrs),
        headers: {
          "User-Agent": "devasign-guidance",
          Accept: "text/html,application/pdf,text/plain,*/*",
          "Accept-Encoding": "identity",
        },
      },
      (res: IncomingMessage) => {
        const status = res.statusCode || 0;
        const location = res.headers.location ?? null;
        const contentType = String(res.headers["content-type"] || "").toLowerCase();
        // Read the (capped) body even on redirects so the socket drains/frees.
        readCappedNodeStream(res, MAX_DOC_BYTES)
          .then((body) => resolve({ status, location, contentType, body }))
          .catch(reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error("request timed out")));
    req.end();
  });

// Indirection so tests can stand in a fake transport without real sockets.
let docTransport: DocTransport = nodeHttpTransport;
export function __setDocTransportForTests(t: DocTransport | null): void {
  docTransport = t || nodeHttpTransport;
}

// Read a Node response stream, stopping (and destroying it) once it exceeds
// maxBytes so a surprise multi-GB body can't blow up memory.
async function readCappedNodeStream(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      res.destroy();
      throw new Error("document is too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// SSRF guard: only fetch public http(s) hosts. Rejects non-http(s) schemes,
// obvious internal names, and any hostname that resolves to a private, loopback,
// link-local (incl. cloud metadata 169.254.169.254) or ULA address. Returns the
// validated addresses so the caller can pin the connection to them.
export async function resolvePublicUrl(raw: string): Promise<{ url: URL; addrs: PinnedAddr[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs are allowed");
  }
  const host = url.hostname;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("URL points at a private address");
    return { url, addrs: [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] };
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new Error("URL host is not public");
  }
  let addrs: PinnedAddr[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("could not resolve host");
  }
  if (!addrs.length) throw new Error("could not resolve host");
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("URL resolves to a private address");
  }
  return { url, addrs };
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
