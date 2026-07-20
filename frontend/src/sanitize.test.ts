// Unit tests for the composer's DOM-free text-safety helpers (sanitize.ts).
// These lock down the security-sensitive URL validation + HTML escaping, and the
// allow-list DOMPurify is configured with. DOMPurify's actual DOM stripping is
// the library's own tested behaviour and needs a browser DOM (this harness has
// no jsdom), so we assert the allow-list config here rather than run sanitize().
// Run:
//   node --test src/sanitize.test.ts        (Node >=22 strips the types)
//   npm test                                 (globs all src/**/*.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  safeUrl,
  sourceLink,
  escapeHtml,
  SANITIZE_ALLOWED_TAGS,
  SANITIZE_ALLOWED_ATTR,
} from "./sanitize.ts";

// ── safeUrl: accept ──────────────────────────────────────────────────────────

test("safeUrl accepts and normalizes http(s) URLs", () => {
  assert.equal(safeUrl("http://example.com"), "http://example.com/");
  assert.equal(safeUrl("https://example.com/x?q=1#f"), "https://example.com/x?q=1#f");
});

test("safeUrl upgrades a schemeless host to https", () => {
  assert.equal(safeUrl("example.com"), "https://example.com/");
  assert.equal(safeUrl("example.com/docs"), "https://example.com/docs");
});

test("safeUrl keeps a host:port (a port is not a scheme)", () => {
  assert.equal(safeUrl("localhost:3000"), "https://localhost:3000/");
  assert.equal(safeUrl("example.com:8080/path"), "https://example.com:8080/path");
});

test("safeUrl trims surrounding whitespace", () => {
  assert.equal(safeUrl("  https://example.com  "), "https://example.com/");
});

// ── safeUrl: reject ──────────────────────────────────────────────────────────

test("safeUrl rejects javascript:/data:/vbscript: and other non-http(s) schemes", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "mailto:a@b.com",
    "tel:+15551234",
    "file:///etc/passwd",
    "ftp://host/x",
  ]) {
    assert.equal(safeUrl(bad), "", `${bad} must be rejected`);
  }
});

test("safeUrl rejects empty / whitespace / nullish input", () => {
  assert.equal(safeUrl(""), "");
  assert.equal(safeUrl("   "), "");
  assert.equal(safeUrl(null), "");
  assert.equal(safeUrl(undefined), "");
});

test("safeUrl rejects garbage that isn't a URL under either candidate", () => {
  assert.equal(safeUrl("not a url with spaces"), "");
});

// ── sourceLink (the agent page's "sources analyzed" render model) ────────────

// The decisive case: a source URL stored before the backend validated them can
// be any string, and the agent page puts it in an href. An unsafe scheme must
// produce no href — but must still be shown, so the maintainer can see what is
// on the task rather than have it silently vanish.
test("sourceLink refuses to link an unsafe URL but still displays it", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"]) {
    const { href, shown } = sourceLink(bad);
    assert.equal(href, "", `${bad} must not become an href`);
    assert.ok(shown.length > 0, `${bad} must still be displayed`);
  }
});

test("sourceLink links a real http(s) URL", () => {
  const { href, shown } = sourceLink("https://www.loom.com/share/deadbeef");
  assert.equal(href, "https://www.loom.com/share/deadbeef");
  assert.equal(shown, "https://www.loom.com/share/deadbeef");
});

test("sourceLink truncates only the display string, never the href", () => {
  const long = "https://example.com/" + "a".repeat(80);
  const { href, shown } = sourceLink(long);
  assert.equal(href, long, "the href must stay whole and navigable");
  assert.equal(shown.length, 39, "38 chars + the ellipsis");
  assert.ok(shown.endsWith("…"));
});

test("sourceLink leaves a URL at the length limit unabbreviated", () => {
  const exact = "https://example.com/" + "a".repeat(20); // exactly 40 chars
  assert.equal(exact.length, 40);
  assert.equal(sourceLink(exact).shown, exact);
});

test("sourceLink handles a missing url (text attachments carry none)", () => {
  for (const empty of ["", null, undefined]) {
    const { href, shown } = sourceLink(empty);
    assert.equal(href, "");
    assert.equal(shown, "");
  }
});

// ── escapeHtml ───────────────────────────────────────────────────────────────

test("escapeHtml escapes &, <, >, and \"", () => {
  assert.equal(escapeHtml(`<b>"x"&y</b>`), "&lt;b&gt;&quot;x&quot;&amp;y&lt;/b&gt;");
  assert.equal(escapeHtml("plain text"), "plain text");
});

test("escapeHtml neutralizes a <script> payload", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

// ── sanitize allow-list (the config DOMPurify strips against) ─────────────────

test("sanitize allow-list excludes every script vector", () => {
  for (const tag of ["script", "img", "svg", "iframe", "style", "object", "embed", "form", "link", "meta", "base"]) {
    assert.ok(!SANITIZE_ALLOWED_TAGS.includes(tag), `<${tag}> must NOT be allow-listed`);
  }
  for (const attr of ["onerror", "onclick", "onload", "onmouseover", "src", "srcset", "style", "formaction"]) {
    assert.ok(!SANITIZE_ALLOWED_ATTR.includes(attr), `${attr} must NOT be allow-listed`);
  }
});

test("sanitize allow-list keeps the formatting tags the composer emits", () => {
  for (const tag of ["b", "strong", "i", "em", "code", "pre", "a", "ul", "ol", "li", "blockquote", "p", "br"]) {
    assert.ok(SANITIZE_ALLOWED_TAGS.includes(tag), `<${tag}> should be allow-listed`);
  }
  // Links may carry only these three attributes (href + safe new-tab hardening).
  assert.deepEqual(SANITIZE_ALLOWED_ATTR, ["href", "target", "rel"]);
});
