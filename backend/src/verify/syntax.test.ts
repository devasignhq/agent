// Offline: a generated file that does not parse is caught before it ships.
//   node --import tsx/esm --test src/verify/syntax.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { syntaxError } from "./syntax.js";

test("the live failure: an invalid regex flag in a Playwright spec is caught, with its line", () => {
  const spec = [
    "import { test, expect } from '@playwright/test'",
    "test('x', async ({ page }) => {",
    "  await expect(page.getByRole('group', { name: /^Edge from /ac }).first()).toBeAttached()",
    "})",
  ].join("\n");
  const err = syntaxError(".devasign/tests/e2e/x.spec.ts", spec) ?? "";
  assert.match(err, /at line 3: /);
  assert.ok(err.includes("name: /^Edge from /ac"), "the offending line is quoted back to the author");
});

test("valid TypeScript, TSX and JavaScript parse; files in other languages are not ours to check", () => {
  assert.equal(syntaxError("a.spec.ts", "import type { Page } from '@playwright/test'\nconst f = (p: Page): void => {}\n"), null);
  assert.equal(syntaxError("a.test.tsx", 'const el = <div className="x">{1}</div>\n'), null);
  assert.equal(syntaxError("a.test.js", "const { total } = require('./total')\n"), null);
  assert.equal(syntaxError("test_a.py", "def test_x(:\n"), null);
  assert.match(syntaxError("a.test.ts", "const x = {\n") ?? "", /at line \d+/);
});
