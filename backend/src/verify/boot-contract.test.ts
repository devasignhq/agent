// DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/boot-contract.test.ts
// The boot-probe wire format is written twice — here and in verify/src/types.ts. These pin the
// two copies together: what the CLI can build must survive normalizeBootReport unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeBootReport } from "./boot-probe.js";
import type { BootReport } from "./contract.js";

const SHA = "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";
// What signArtifactFiles hands back: a uuid v4, which the normalizer's id pattern must accept.
const LOG_ID = "6f1c2f4e-8b3a-4d5c-9e0f-1a2b3c4d5e6f";
const SHOT_ID = "b2d4e6f8-0a1c-4e3d-8f5a-6b7c8d9e0f1a";

const overWire = (r: unknown): unknown => JSON.parse(JSON.stringify(r));

test("every report the CLI can build survives the normalizer with nothing dropped", () => {
  // verify/src/boot-probe.ts bootAndLoad(), success path: every optional field populated.
  const cameUp: BootReport = {
    sha: SHA,
    ok: true,
    stage: "done",
    durationMs: 41_337,
    cliVersion: "1.7.0",
    servers: [
      { name: "api", ok: true, readyMs: 509 },
      { name: "app", ok: true, readyMs: 520 },
    ],
    login: { ran: true, checked: true, ok: true, checkStatus: 200, cors: "ok" },
    page: { status: 200 },
    logArtifactId: LOG_ID,
    screenshotArtifactId: SHOT_ID,
  };
  assert.deepEqual(normalizeBootReport(overWire(cameUp)), cameUp);

  // Failure at a named server: failedServer, an exit code, a diagnosis carrying the log id.
  const serverDied: BootReport = {
    sha: SHA,
    ok: false,
    stage: "servers",
    failedServer: "api",
    durationMs: 3_120,
    cliVersion: "1.7.0",
    servers: [{ name: "api", ok: false, exitCode: 3 }],
    diagnosis: { stage: "start", code: "app_not_ready", message: "the api server exited before it was ready", logArtifactId: LOG_ID },
    logArtifactId: LOG_ID,
  };
  assert.deepEqual(normalizeBootReport(overWire(serverDied)), serverDied);

  // Preflight: the `base` report, before anything boots and before any artifact exists.
  const preflight: BootReport = {
    sha: SHA,
    ok: false,
    stage: "config",
    durationMs: 0,
    cliVersion: "1.7.0",
    servers: [],
    diagnosis: { stage: "start", code: "no_start_command", message: "there is no start command to run" },
  };
  assert.deepEqual(normalizeBootReport(overWire(preflight)), preflight);

  // The two nulls the CLI emits by design: an unknown exit code and a page that answered nothing.
  const nulls: BootReport = {
    sha: SHA,
    ok: false,
    stage: "page",
    durationMs: 9_001,
    cliVersion: "1.7.0",
    servers: [{ name: "api", ok: true, readyMs: 480, exitCode: null }],
    page: { status: null },
    diagnosis: { stage: "start", code: "app_not_ready", message: "the app answered nothing at its ready URL" },
  };
  assert.deepEqual(normalizeBootReport(overWire(nulls)), nulls);

  // A success carries `diagnosis: null` over the wire; absent and null both mean "no diagnosis",
  // so the normalizer drops the key. Everything else must still come back untouched.
  const withNullDiagnosis = { ...cameUp, diagnosis: null };
  assert.deepEqual(normalizeBootReport(overWire(withNullDiagnosis)), cameUp);
});

test("the CLI's copy of the boot wire format has not drifted from the backend's", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const backend = read("./contract.ts");
  const cli = read("../../../verify/src/types.ts");

  // Comments and wrapping may differ between the copies; the declaration may not.
  const declaration = (src: string, name: string): string => {
    const start = src.indexOf(`export type ${name} =`);
    assert.notEqual(start, -1, `${name} is missing`);
    const end = src.indexOf("\n\n", start);
    return src
      .slice(start, end === -1 ? undefined : end)
      .replace(/\/\/.*$/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  for (const name of ["BootStage", "BootReport", "BootProbeOffer"]) {
    assert.equal(declaration(cli, name), declaration(backend, name), `${name} differs between the two copies`);
  }

  // The offer rides on the empty resolve. `reason` is deliberately looser on the CLI side.
  for (const src of [backend, cli]) assert.match(src, /status: "empty";[^\n]*probe\?: BootProbeOffer/);
});
