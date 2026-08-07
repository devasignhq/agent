// summarizeVideo authenticates to Gemini with a long-lived, org-billed key. It
// must travel as an x-goog-api-key header and never as a ?key= query param:
// request URLs are the part of a call that proxy access logs, APM spans and
// fetch wrappers capture by default, so a URL-borne key leaks to every log sink
// that ever gets switched on. Nothing about the response changes either way,
// which is why this needs a test — the insecure form works perfectly. Offline:
// the key is pinned on config and global fetch is stubbed. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/llm-video-auth.test.ts
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "./config.js";
import { summarizeVideo } from "./llm.js";

const realFetch = globalThis.fetch;
const realKey = config.gemini.apiKey;
const KEY = "AIza-test-key-do-not-log";

let calls: Array<{ url: string; init: any }> = [];

beforeEach(() => {
  calls = [];
  // A configured key is what makes isGeminiLive() true; without it summarizeVideo
  // short-circuits to the mock and never issues a request at all.
  config.gemini.apiKey = KEY;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: '{"summary":"ok"}' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        };
      },
      async text() { return ""; },
    };
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  config.gemini.apiKey = realKey;
});

test("the api key is sent as a header and never appears in the request URL", async () => {
  // YouTube is the provider that actually reaches Gemini.
  await summarizeVideo({ url: "https://www.youtube.com/watch?v=abc123" });

  assert.equal(calls.length, 1, "expected exactly one Gemini request");
  const { url, init } = calls[0];

  assert.ok(!url.includes("key="), `URL must carry no key param: ${url}`);
  // Check the whole URL, not just the query, so an encoded or relocated copy of
  // the credential can't slip past the param check above.
  assert.ok(!url.includes(KEY), "the key must not appear anywhere in the URL");
  assert.ok(!url.includes(encodeURIComponent(KEY)), "…nor percent-encoded");

  assert.equal(
    init?.headers?.["x-goog-api-key"],
    KEY,
    "the key must be sent as the x-goog-api-key header",
  );
});
