// Trace zips are built and read back with Playwright's own zip libraries (yazl/yauzl), so the
// rewrite is checked against the reader the trace viewer family uses, not against itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { StorageState } from "./boot.js";
import { redactTrace } from "./trace-redact.js";

const { yazl, yauzl } = createRequire(import.meta.url)("playwright-core/lib/zipBundle");

function buildZip(entries: Array<{ name: string; body: Buffer | string; compress?: boolean }>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const e of entries) zip.addBuffer(Buffer.from(e.body), e.name, { compress: e.compress ?? true });
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
  });
}

function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err: Error | null, zip: any) => {
      if (err) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on("entry", (entry: any) =>
        zip.openReadStream(entry, (e: Error | null, stream: any) => {
          if (e) return reject(e);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c)).on("end", () => (out.set(entry.fileName, Buffer.concat(chunks)), zip.readEntry())).on("error", reject);
        })
      );
      zip.on("end", () => resolve(out)).on("error", reject);
      zip.readEntry();
    });
  });
}

const state: StorageState = {
  cookies: [
    { name: "sid", value: "abc", domain: "localhost", path: "/" },
    { name: "session", value: "s3cr3t-session-value", domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ],
  origins: [{ origin: "http://localhost:4181", localStorage: [{ name: "tok", value: "xy" }] }],
};
const env = { MY_API_TOKEN: "tok-123456789" } as NodeJS.ProcessEnv;
const binary = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.from("s3cr3t-session-value")]);

const traceLines = [
  { type: "context-options", options: { baseURL: "http://localhost:4181", storageState: state } },
  { type: "frame-snapshot", snapshot: { html: ["P", {}, "Cookie: visible text on the page"] } },
  { type: "action", apiName: "page.goto", params: { url: "/" } },
];
const networkLines = [
  {
    type: "resource-snapshot",
    snapshot: {
      request: { headers: [{ name: "cookie", value: "sid=abc; session=s3cr3t-session-value" }], cookies: [{ name: "sid", value: "abc" }] },
      response: { headers: [{ name: "Set-Cookie", value: "refreshed=new-token-from-app; Path=/" }], cookies: [{ name: "refreshed", value: "new-token-from-app" }] },
    },
  },
];
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

test("redactTrace scrubs the session and secrets from every text entry and leaves a zip Playwright can read", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dv-trace-"));
  const file = path.join(dir, "trace.zip");
  const untouched = "export const x = 1;\n";
  writeFileSync(
    file,
    await buildZip([
      { name: "0-trace.trace", body: jsonl(traceLines) },
      { name: "0-trace.network", body: jsonl(networkLines) },
      { name: "resources/src@1.txt", body: `const token = "${env.MY_API_TOKEN}";\n`, compress: false },
      { name: "resources/src@2.txt", body: untouched },
      { name: "resources/0a1b2c", body: binary },
    ])
  );

  redactTrace(file, { env, state });

  const out = await unzip(readFileSync(file));
  assert.deepEqual([...out.keys()], ["0-trace.trace", "0-trace.network", "resources/src@1.txt", "resources/src@2.txt", "resources/0a1b2c"]);
  for (const name of ["0-trace.trace", "0-trace.network", "resources/src@1.txt"]) {
    const text = out.get(name)!.toString("utf8");
    for (const leak of ["s3cr3t-session-value", "new-token-from-app", '"value":"abc"', '"value":"xy"', "sid=abc", env.MY_API_TOKEN!]) {
      assert.equal(text.includes(leak), false, `${name} still carries ${leak}`);
    }
  }
  const trace = out.get("0-trace.trace")!.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(trace.length, 3, "every trace line is still one JSON event");
  assert.deepEqual(trace[0].options.storageState.cookies.map((c: any) => [c.name, c.value, c.domain]), [["sid", "[redacted]", "localhost"], ["session", "[redacted]", "localhost"]]);
  assert.equal(trace[1].snapshot.html[2], "Cookie: visible text on the page", "page text that mentions a cookie is not cut short");
  const network = JSON.parse(out.get("0-trace.network")!.toString("utf8"));
  assert.equal(network.snapshot.response.headers[0].value, "[redacted]");
  assert.equal(out.get("resources/src@2.txt")!.toString("utf8"), untouched);
  assert.ok(out.get("resources/0a1b2c")!.equals(binary), "binary resources are left byte-for-byte");
});

test("redactTrace leaves a trace with nothing to scrub as it was, and removes one it cannot read", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dv-trace-"));
  const clean = path.join(dir, "clean.zip");
  const bytes = await buildZip([{ name: "0-trace.trace", body: jsonl([traceLines[2]]) }]);
  writeFileSync(clean, bytes);
  redactTrace(clean, { env, state });
  assert.ok(readFileSync(clean).equals(bytes), "an unchanged trace is not rewritten");

  const broken = path.join(dir, "broken.zip");
  writeFileSync(broken, (await buildZip([{ name: "0-trace.trace", body: jsonl(traceLines) }])).subarray(0, 60));
  redactTrace(broken, { env, state });
  assert.equal(existsSync(broken), false, "a trace that cannot be scrubbed is never uploaded");

  assert.doesNotThrow(() => redactTrace(path.join(dir, "missing.zip"), { env, state }));
});

test("a signed-in trace loses bearer tokens taken from JSON localStorage and IndexedDB, not only the stored strings", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dv-trace-"));
  const file = path.join(dir, "trace.zip");
  const access = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.supabase-access";
  const firebase = "firebase-id-token-abcdef";
  const signedIn: StorageState = {
    cookies: [],
    origins: [{
      origin: "http://localhost:4173",
      localStorage: [{ name: "sb-x-auth-token", value: JSON.stringify({ access_token: access, refresh_token: "refresh-abcdef" }) }],
      indexedDB: [{ name: "firebaseLocalStorageDb", version: 1, stores: [{ name: "firebaseLocalStorage", autoIncrement: false, records: [{ key: "u", value: { stsTokenManager: { accessToken: firebase } } }] }] }],
    }],
  };
  writeFileSync(
    file,
    await buildZip([
      { name: "0-trace.trace", body: jsonl([{ type: "context-options", options: { storageState: signedIn } }]) },
      { name: "0-trace.network", body: jsonl([{ type: "resource-snapshot", snapshot: { request: { headers: [{ name: "authorization", value: `Bearer ${access}` }, { name: "x-firebase-token", value: firebase }] } } }]) },
    ])
  );
  redactTrace(file, { env: {}, state: signedIn });
  const out = await unzip(readFileSync(file));
  for (const [name, bytes] of out) {
    const text = bytes.toString("utf8");
    for (const leak of [access, "refresh-abcdef", firebase]) assert.equal(text.includes(leak), false, `${name} still carries ${leak}`);
    for (const line of text.trim().split("\n")) JSON.parse(line);
  }
  assert.equal(JSON.parse(out.get("0-trace.network")!.toString("utf8")).snapshot.request.headers[0].value, "[redacted]");
});
