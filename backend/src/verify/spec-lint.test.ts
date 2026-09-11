// Offline: Playwright patterns that fail at run time are caught before the spec ships.
//   node --import tsx/esm --test src/verify/spec-lint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { specLint } from "./spec-lint.js";

const RF = ["@xyflow/react", "@playwright/test"];
const spec = (...body: string[]) => ["import { test, expect } from '@playwright/test'", ...body].join("\n");

test("the live misses: clicking a line, directly or through a locator built from one", () => {
  assert.match(specLint(spec("  await page.getByRole('group', { name: 'Edge from a to b' }).click()"), RF)[0], /clicks a React Flow line/);
  const viaVar = spec("  const edgePath = page.locator('.react-flow__edge').first().locator('.money-edge')", "  await edgePath.click({ force: true })");
  assert.match(specLint(viaVar, RF)[0], /press\('Enter'\)/);
  const derived = spec("  const line = page.getByRole('group', { name: /^Edge from / }).first()", "  const path = line.locator('path')", "  await path.dblclick()");
  assert.equal(specLint(derived, RF).length, 1, "a locator built from a line is still a line");
  const wrapped = spec("  await page", "    .getByRole('group', { name: 'Edge from a to b' })", "    .click()");
  assert.equal(specLint(wrapped, RF).length, 1, "a chain a formatter split over lines");
  const splitDecl = spec("  const edge = page", "    .getByRole('group', { name: 'Edge from a to b' })", "  await edge.click()");
  assert.equal(specLint(splitDecl, RF).length, 1, "a declaration a formatter split over lines");
});

test("the live miss: waiting for a line picked by position to be visible", () => {
  assert.match(specLint(spec("  await page.locator('.react-flow__edge').first().waitFor()"), RF)[0], /empty box/);
  assert.equal(specLint(spec("  await expect(", "    page.locator('.react-flow__edge').first(),", "  ).toBeVisible()"), RF).length, 1);
  assert.deepEqual(specLint(spec("  await page.getByRole('group', { name: 'Edge from n1 to n2' }).waitFor({ state: 'attached' })"), RF), []);
});

test("the later live misses: a helper that returns a line, and a line picked by position then waited on", () => {
  const arrow = spec(
    "const edge = (page: Page, source: string, target: string): Locator =>",
    "  page.getByRole('group', { name: `Edge from ${source} to ${target}` })",
    "  await edge(page, 'n1', 'n2').click()"
  );
  assert.match(specLint(arrow, RF)[0], /clicks a React Flow line/, "an arrow helper a formatter broke after `=>`");
  const fn = spec(
    "function edge(page: Page, a: string, b: string) {",
    "  return page.getByRole('group', { name: `Edge from ${a} to ${b}` })",
    "}",
    "  const line = edge(page, 'n1', 'n2')",
    "  await line.click()"
  );
  assert.equal(specLint(fn, RF).length, 1, "a line a function helper returned, then held");
  const held = spec("  const line = page.getByRole('group', { name: /^Edge from / }).first()", "  await line.waitFor()", "  await line.press('Enter')");
  assert.match(specLint(held, RF)[0], /empty box/);
  const counted = spec("  const n = await page.locator('.react-flow__edge').count()", "  await page.getByText(`${n} lines`).click()");
  assert.deepEqual(specLint(counted, RF), [], "an awaited value is not a locator");
});

test("what the notes recommend passes, and a count read off a line is not a line", () => {
  const good = spec(
    "  const lines = page.getByRole('group', { name: /^Edge from / })",
    "  const count = await lines.count()",
    "  await lines.first().press('Enter')",
    "  await page.keyboard.down('ControlOrMeta')",
    "  await page.getByRole('group', { name: 'Edge from n2 to n3' }).press('Enter')",
    "  await page.getByText(`${count} lines`).click()",
    "  // a line's centre would miss: await lines.first().click()",
    "  await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } })"
  );
  assert.deepEqual(specLint(good, RF), []);
});

test("line rules need React Flow; the page-wide role rule applies to any spec; other files are not ours", () => {
  const click = spec("  await page.getByRole('group', { name: 'Edge from a to b' }).click()");
  assert.deepEqual(specLint(click, ["@playwright/test"]), [], "no React Flow, no line rules");
  assert.match(specLint(spec("  await page.getByRole('option').first().click()"), ["@playwright/test"])[0], /page-wide role query/);
  assert.deepEqual(specLint(spec("  await list.getByRole('option').first().click()", "  await page.getByRole('option', { name: 'NIH' }).click()"), ["@playwright/test"]), []);
  assert.deepEqual(specLint("import { it } from 'vitest'\nfireEvent.click(document.querySelector('.react-flow__edge'))\n", RF), [], "not a Playwright spec");
});
