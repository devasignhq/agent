// Shared SSRF guard for every server-side fetch of a URL we did not author.
// Sibling of csrf.ts. The rule: a URL that reaches us from a maintainer, a
// GitHub comment, or a Linear ticket is hostile until proven otherwise.
//
// Two controls, and BOTH are load-bearing:
//   1. resolvePublicUrl() — resolve the host and reject loopback / link-local
//      (which is where the 169.254.169.254 cloud-metadata endpoint lives) /
//      private / CGNAT / ULA addresses, plus non-http(s) schemes and
//      internal-only names.
//   2. fetchGuarded() — re-validate EVERY redirect hop, and pin each connection
//      to the exact addresses just validated. Validation without pinning is a
//      TOCTOU: DNS can hand back a public IP for the check and a private one
//      microseconds later at connect (DNS rebinding). Pinning without per-hop
//      re-validation is just as broken: a public host can 302 to metadata.
//
// This lived only in review/guidance.ts, so the Linear attachment path grew its
// own ad-hoc host check and got it wrong — a substring test that accepted
// `linear.app.evil.com` as Linear and handed it the workspace OAuth token. One
// definition, one place, so the next caller inherits the guard instead of
// reinventing it.

import { lookup } from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";

export type PinnedAddr = { address: string; family: number };
export type GuardedResponse = {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
};
// One request to an already-validated, IP-pinned host. `opts` is optional so
// test fakes can keep the terse (url, addrs, signal) shape.
export type GuardedTransport = (
  url: URL,
  addrs: PinnedAddr[],
  signal: AbortSignal,
  opts?: { headers?: Record<string, string>; maxBytes?: number }
) => Promise<GuardedResponse>;

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Exact apex-or-subdomain host match — the only correct way to ask "is this host
 * theirs?". A substring or \b-bounded regex matches attacker-controlled
 * positions: /\blinear\.app\b/ accepts `linear.app.evil.com`, and testing the
 * whole URL rather than the parsed host also accepts `https://internal/?x=linear.app`.
 * Always pass a parsed URL's `hostname` (NOT `host`, which carries the port).
 */
export function hostMatches(host: string, apex: string): boolean {
  const h = host.toLowerCase();
  const a = apex.toLowerCase();
  return h === a || h.endsWith("." + a);
}

export function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, ""); // unwrap IPv4-mapped IPv6
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast 224.0.0.0/4 + reserved/broadcast 240.0.0.0/4
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("ff")) return true; // multicast ff00::/8
  // Documentation 2001:db8::/32 (RFC 3849). Match the second hextet with optional
  // leading zeros so the compressed (2001:db8:), padded (2001:0db8:) and expanded
  // forms all hit — a bare startsWith("2001:db8:") lets 2001:0db8::1 slip through.
  if (/^2001:0*db8:/.test(lower)) return true;
  return false;
}

// Names that never belong to a public host, so they need no DNS round-trip.
const INTERNAL_NAME_RE = /^(localhost|.*\.local|.*\.internal)$/i;

/**
 * Synchronous, DNS-free reject for hosts that cannot possibly be public: private
 * IP literals and internal-only names. For callers that want a cheap pre-filter
 * (e.g. deciding whether a URL is even a candidate) without an async budget.
 *
 * NOT a boundary, by construction: a hostname that merely RESOLVES to a private
 * address looks fine here. resolvePublicUrl() + fetchGuarded() are the boundary.
 */
export function isObviouslyNonPublicHost(hostname: string): boolean {
  return net.isIP(hostname) ? isPrivateIp(hostname) : INTERNAL_NAME_RE.test(hostname);
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
  if (INTERNAL_NAME_RE.test(host)) {
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

// Lock a connection's DNS resolution to the pre-validated addresses, so the
// socket cannot be steered to a different (private) IP than the one we checked.
// Matches the net.connect `lookup` contract (dns.lookup-style, with `all`).
export function pinnedLookup(addrs: PinnedAddr[]) {
  return (_hostname: string, options: any, cb: any) => {
    if (options && options.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  };
}

// Map Node's AbortError (fired when an absolute-timeout signal trips) onto a
// stable message so errored items read consistently.
function asTimeoutOnAbort(err: any): Error {
  if (err?.name === "AbortError" || err?.code === "ABORT_ERR") return new Error("request timed out");
  return err instanceof Error ? err : new Error(String(err));
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

// The real transport: a GET over node:http/https, pinned to `addrs` via the
// `lookup` option (so there is no second DNS resolution to rebind), with SNI +
// cert validation still keyed off the URL hostname. `Accept-Encoding: identity`
// keeps the body uncompressed so we can read it without a decompressor.
const nodeHttpTransport: GuardedTransport = (url, addrs, signal, opts) =>
  new Promise<GuardedResponse>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("request timed out"));
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(addrs),
        // Absolute deadline (set by the caller) — aborts connect, headers AND
        // the body read, so a slow-drip server can't hold the socket open.
        signal,
        headers: { "Accept-Encoding": "identity", ...(opts?.headers ?? {}) },
      },
      (res: IncomingMessage) => {
        const status = res.statusCode || 0;
        const location = res.headers.location ?? null;
        const contentType = String(res.headers["content-type"] || "").toLowerCase();
        // Read the (capped) body even on redirects so the socket drains/frees.
        readCappedNodeStream(res, opts?.maxBytes ?? DEFAULT_MAX_BYTES)
          .then((body) => resolve({ status, location, contentType, body }))
          .catch((err) => reject(asTimeoutOnAbort(err)));
      }
    );
    req.on("error", (err) => reject(asTimeoutOnAbort(err)));
    req.end();
  });

// Indirection so tests can stand in a fake transport without real sockets.
let transport: GuardedTransport = nodeHttpTransport;
export function __setGuardedTransportForTests(t: GuardedTransport | null): void {
  transport = t || nodeHttpTransport;
}

/**
 * GET `initialUrl` behind the SSRF guard, following redirects manually and
 * re-validating + re-pinning every hop.
 *
 * `headersFor` is recomputed per hop and receives the URL actually about to be
 * requested. That is the only safe way to attach credentials: a redirect must
 * never carry an Authorization header to a host that did not earn it.
 */
export async function fetchGuarded(
  initialUrl: string,
  opts: {
    signal: AbortSignal;
    maxBytes?: number;
    maxRedirects?: number;
    headersFor?: (url: URL) => Record<string, string>;
  }
): Promise<{ buf: Buffer; contentType: string; url: URL }> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = initialUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, addrs } = await resolvePublicUrl(current);
    const res = await transport(url, addrs, opts.signal, {
      headers: opts.headersFor?.(url) ?? {},
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      if (!res.location) throw new Error(`redirect with no location (HTTP ${res.status})`);
      // Resolve relative redirects against the URL we just requested, then loop
      // back so the new host is itself validated + pinned before we connect.
      current = new URL(res.location, url).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`fetch failed (HTTP ${res.status})`);
    return { buf: res.body, contentType: res.contentType, url };
  }
  throw new Error("too many redirects");
}
