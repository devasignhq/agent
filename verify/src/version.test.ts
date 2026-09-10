// node --import tsx/esm --test src/version.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLI_VERSION } from "./types.js";

// 1.3.0 shipped announcing itself as 1.2.0, which is what the API recorded for every
// run of it. This covers the tsx path; scripts/build.mjs asserts the same of the bundle.
test("CLI_VERSION is the version this package publishes as", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(CLI_VERSION, pkg.version);
  assert.match(CLI_VERSION, /^\d+\.\d+\.\d+/);
});
