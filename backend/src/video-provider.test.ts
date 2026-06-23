// Offline tests for detectVideoProvider. No API keys, no network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/video-provider.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectVideoProvider } from "./llm.js";

// Genuine provider URLs (apex + common subdomains) still classify correctly so
// summarizeVideo keeps handing real YouTube links to Gemini's direct-ingest path.
test("detectVideoProvider classifies legitimate provider URLs by hostname", () => {
  const cases: Array<[string, string]> = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://youtube.com/watch?v=abc", "youtube"],
    ["https://m.youtube.com/watch?v=abc", "youtube"],
    ["https://music.youtube.com/watch?v=abc", "youtube"],
    ["https://youtu.be/dQw4w9WgXcQ", "youtube"],
    ["https://www.loom.com/share/deadbeef", "loom"],
    ["https://loom.com/share/deadbeef", "loom"],
    ["https://vimeo.com/123456789", "vimeo"],
    ["https://player.vimeo.com/video/123456789", "vimeo"],
  ];
  for (const [url, want] of cases) {
    assert.equal(detectVideoProvider(url), want, `expected ${url} → ${want}`);
  }
});

// The decisive regression: a substring match would tag these "youtube" and let
// summarizeVideo forward them to Gemini as a fileData fileUri (SSRF / unintended
// fetch). A hostname allowlist must return null so they take the inference path.
test("detectVideoProvider rejects look-alike, internal, and non-http(s) URLs", () => {
  const rejected = [
    "https://internal-host/?x=youtube.com/",     // youtube.com in query
    "https://attacker.com/youtube.com/watch",    // youtube.com/ in path
    "https://youtube.com.evil.com/watch",        // suffix-spoofed host
    "https://evilyoutube.com/watch",             // missing dot boundary
    "https://127.0.0.1/youtube.com/",            // internal IP
    "https://localhost/loom.com/share/x",        // internal name
    "file:///youtube.com/etc/passwd",            // non-http(s) scheme
    "javascript:fetch('//youtube.com/')",        // non-http(s) scheme
    "not a url",                                  // unparseable
    "",                                           // empty
  ];
  for (const url of rejected) {
    assert.equal(detectVideoProvider(url), null, `expected ${url} → null`);
  }
});
