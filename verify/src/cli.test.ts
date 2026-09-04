// The entry point itself: `npx @devasign/verify` must reach main(). An
// argv/import.meta.url comparison here once made the bin exit silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLI_VERSION } from "./types.js";

const run = promisify(execFile);
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");

test("running the module as an entry point invokes main()", async () => {
  const { stdout } = await run(process.execPath, ["--import", "tsx/esm", cli, "--help"]);
  assert.match(stdout, /Usage: devasign-verify/, "main() ran and printed help");
  assert.match(stdout, new RegExp(CLI_VERSION.replace(/\./g, "\\.")));
});

test("an unknown subcommand exits non-zero rather than hanging", async () => {
  await assert.rejects(
    () => run(process.execPath, ["--import", "tsx/esm", cli, "nonsense"]),
    (err: any) => err.code === 2 || err.code === 1
  );
});
