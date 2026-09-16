// A test runner reached through a wrapper (npx, npm exec, sh) spawns
// grandchildren that inherit our pipes. Killing only the direct child leaves
// them holding stdout, "close" never fires, and the customer's CI job hangs
// until GitHub's 6-hour limit. Run:
//   node --import tsx/esm --test src/exec.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./exec.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a timeout kills the whole process group and settles even when a grandchild holds the pipes", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-exec-"));
  const marker = path.join(root, "alive.log");
  writeFileSync(
    path.join(root, "hang.js"),
    `const fs = require("fs");\nsetInterval(() => { fs.appendFileSync(${JSON.stringify(marker)}, "x"); console.log("tick"); }, 100);\n`
  );
  // `; true` keeps the shell alive as a real parent instead of exec-ing the child.
  const started = Date.now();
  const res = await runCommand({
    cmd: "/bin/sh",
    args: ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "hang.js"))}; true`],
    cwd: root,
    timeoutMs: 1_500,
  });
  const elapsed = Date.now() - started;
  assert.equal(res.timedOut, true, "the timeout must be reported");
  assert.ok(elapsed < 20_000, `runCommand settled in ${elapsed}ms instead of hanging`);
  assert.match(res.output, /tick/, "output captured before the kill is kept");

  // The grandchild must be dead, not orphaned and still writing.
  const at = existsSync(marker) ? readFileSync(marker, "utf8").length : 0;
  await sleep(600);
  const after = existsSync(marker) ? readFileSync(marker, "utf8").length : 0;
  assert.equal(after, at, "a surviving grandchild would keep appending");
});

test("a normal command still resolves with its exit code and output", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-exec-ok-"));
  const ok = await runCommand({ cmd: process.execPath, args: ["-e", "console.log('hello'); process.exit(0)"], cwd: root, timeoutMs: 10_000 });
  assert.equal(ok.code, 0);
  assert.equal(ok.timedOut, false);
  assert.match(ok.stdout, /hello/);

  const bad = await runCommand({ cmd: process.execPath, args: ["-e", "console.error('boom'); process.exit(3)"], cwd: root, timeoutMs: 10_000 });
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /boom/);

  const missing = await runCommand({ cmd: path.join(root, "nope"), args: [], cwd: root, timeoutMs: 10_000 });
  assert.ok(missing.spawnError, "a spawn failure is reported, not thrown");
});

test("a line handler that throws cannot take the run down with it", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-exec-throw-"));
  // onLine runs inside a stream "data" handler, where a throw is an uncaught exception —
  // it escapes every try/catch on the call path and ends the process.
  const seen: string[] = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    const res = await runCommand({
      cmd: process.execPath,
      args: ["-e", 'console.log("first"); console.log("second"); process.stdout.write("tail")'],
      cwd: root,
      timeoutMs: 10_000,
      onLine: (l) => {
        seen.push(l);
        throw new Error("a scrub blew up");
      },
    });
    assert.equal(res.code, 0);
    assert.deepEqual(seen, ["first", "second", "tail"], "every line is still offered");
  } finally {
    console.warn = warn;
  }
});

test("onLine gets whole lines tagged with their stream, even when a line arrives split across pipe chunks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-exec-lines-"));
  // The pauses force separate chunks: the header, then its value, then a final line with no newline.
  const src = `const w = (s) => process.stdout.write(s); w("Set-Cookie: sid="); setTimeout(() => { w("s3cr3t-value\\nnext line\\n"); process.stderr.write("oops\\n"); setTimeout(() => w("tail without newline"), 150); }, 150);`;
  const lines: Array<[string, string]> = [];
  const res = await runCommand({ cmd: process.execPath, args: ["-e", src], cwd: root, timeoutMs: 10_000, onLine: (l, stream) => lines.push([stream, l]) });
  assert.equal(res.code, 0);
  assert.deepEqual(lines.filter(([s]) => s === "out").map(([, l]) => l), ["Set-Cookie: sid=s3cr3t-value", "next line", "tail without newline"]);
  assert.deepEqual(lines.filter(([s]) => s === "err"), [["err", "oops"]]);
});
