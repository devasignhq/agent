// A plan with nothing to run, driven through an in-process fake /v1: the CLI
// must still say why, write its outputs, and honour --fail-on unverifiable.
//   node --import tsx/esm --test src/run-failon.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./run.js";
import { staticTokenSource } from "./oidc.js";
import type { FailOn, RunnerPlan } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "..", "fixtures", "no-framework-app");

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const c: Buffer[] = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => resolve(Buffer.concat(c)));
  });
}

const emptyPlan = (failOn: FailOn): RunnerPlan => ({
  planId: "plan-empty",
  criteriaRevision: 1,
  criteria: [{ id: "1", text: "The pill shows", kind: "ui" }],
  tests: [],
  commands: [],
  playwright: null,
  retries: { generated: 2, existing: 0 },
  uploadLimits: { maxFileBytes: 1e6, maxTotalBytes: 1e6, maxFiles: 10 },
  unverifiable: [{ criterionId: "1", reason: "no app start / login configured", fixUrl: "https://app/workflow?repo=r" }],
  failOn,
});

async function drive(opts: { plan: RunnerPlan; failOn?: FailOn; outputFile?: string }): Promise<{ code: number; results: unknown; polls: number; logs: string[] }> {
  let results: unknown = null;
  let polls = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const json = (code: number, b: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (url.pathname === "/v1/runs/resolve") {
      await body(req);
      return json(200, { ok: true, status: "ready", runId: "run-1", plan: opts.plan });
    }
    if (url.pathname === "/v1/runs/run-1/results") {
      results = JSON.parse((await body(req)).toString());
      return json(200, { ok: true, runId: "run-1", status: "judging" });
    }
    if (url.pathname === "/v1/runs/run-1" && req.method === "GET") {
      polls += 1;
      return json(200, {
        ok: true,
        terminal: true,
        run: { id: "run-1", status: "completed", verdicts: [{ criterionId: "1", verdict: "unverifiable", reason: "No app start was configured.", fixUrl: "https://app/workflow?repo=r" }] },
      });
    }
    json(404, { ok: false, error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (m: unknown) => logs.push(String(m));
  console.error = (m: unknown) => logs.push(String(m));
  const prevOutput = process.env.GITHUB_OUTPUT;
  if (opts.outputFile) process.env.GITHUB_OUTPUT = opts.outputFile;
  else delete process.env.GITHUB_OUTPUT;
  try {
    const code = await run({ apiUrl: `http://127.0.0.1:${port}`, token: staticTokenSource("dev-token"), failOn: opts.failOn, resolveTimeoutMs: 10_000, testTimeoutMs: 10_000, keep: false, cwd: fixture, pr: 7, sha: "abc1234" });
    return { code, results, polls, logs };
  } finally {
    console.log = origLog;
    console.error = origErr;
    if (prevOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prevOutput;
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(path.join(fixture, ".devasign"), { recursive: true, force: true });
  }
}

test("--fail-on unverifiable: an uncovered criterion fails the job and names the fix", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devasign-out-"));
  const outputFile = path.join(dir, "out.txt");
  try {
    const { code, results, polls, logs } = await drive({ plan: emptyPlan("never"), failOn: "unverifiable", outputFile });
    assert.equal(code, 1);
    assert.equal(polls, 1);
    assert.ok(results, "empty results are still posted so the judge can run");
    assert.ok(logs.some((l) => /criterion 1 is unverifiable: no app start \/ login configured — fix: https:\/\/app\/workflow\?repo=r/.test(l)), "the planned reason is announced");
    assert.ok(logs.some((l) => /no tests could be planned for this PR/.test(l)));
    assert.ok(logs.some((l) => /criterion 1 could not be verified: No app start was configured\. — fix: https:\/\/app\/workflow\?repo=r/.test(l)), "the verdict is printed before failing");
    const out = readFileSync(outputFile, "utf8");
    assert.match(out, /^run-id=run-1$/m);
    assert.match(out, /^outcome=no tests ran, 1 unverifiable by plan$/m);
    assert.doesNotMatch(out, /^browsers=/m, "no browsers were installed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--fail-on unset: the plan's server-side default applies", async () => {
  const strict = await drive({ plan: emptyPlan("unverifiable") });
  assert.equal(strict.code, 1);
  const lax = await drive({ plan: emptyPlan("never") });
  assert.equal(lax.code, 0);
  assert.equal(lax.polls, 0, "never does not wait for the verdict");
});

test("--fail-on verdict: an unverifiable criterion does not fail the job", async () => {
  const { code, polls } = await drive({ plan: emptyPlan("never"), failOn: "verdict" });
  assert.equal(code, 0);
  assert.equal(polls, 1);
});
