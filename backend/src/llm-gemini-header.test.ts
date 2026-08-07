import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeVideo } from "./llm.js";

test("summarizeVideo sends Gemini API key via x-goog-api-key header and not URL query parameter", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = input.toString();
    if (init?.headers) {
      capturedHeaders = init.headers as Record<string, string>;
    }
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "test summary" }) }] } }],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    process.env.GEMINI_API_KEY = "test-secret-gemini-key";
    await summarizeVideo({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });

    assert.ok(!capturedUrl.includes("key="), "Request URL must not contain key= query parameter");
    assert.equal(capturedHeaders["x-goog-api-key"], "test-secret-gemini-key", "x-goog-api-key header must contain the API key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
