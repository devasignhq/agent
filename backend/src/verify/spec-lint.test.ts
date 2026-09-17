// Offline: Playwright patterns that fail at run time are caught before the spec ships.
//   node --import tsx/esm --test src/verify/spec-lint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { specLint, specLintCertain } from "./spec-lint.js";

const RF = ["@xyflow/react", "@playwright/test"];
const spec = (...body: string[]) => ["import { test, expect } from '@playwright/test'", ...body].join("\n");

const PW = ["@playwright/test"];

test("the live miss: waiting for the network to fall idle, which a stream the app holds open never lets happen", () => {
  const incident = spec('  await page.waitForLoadState("networkidle");');
  assert.equal(specLint(incident, PW).length, 1, "it applies to any Playwright spec, React Flow or not");
  assert.match(specLint(incident, PW)[0], /^it waits for the network to fall idle \(`await page\.waitForLoadState\("networkidle"\);`\)/);
  const variants = [
    ["  await page.waitForLoadState('networkidle')", "single quotes"],
    ["  await page.waitForLoadState(`networkidle`)", "a template literal"],
    ["  await appPage.waitForLoadState('networkidle')", "a page bound to another name"],
    ["  await context.pages()[0].waitForLoadState('networkidle')", "a page reached through the context"],
    ["  void page.waitForLoadState('networkidle')", "the call left unawaited"],
    ["  await page.goto('/agents', { waitUntil: 'networkidle' })", "the same never-idle condition on a navigation"],
    ["  await page.waitForURL('/agents', { waitUntil: 'networkidle' })", "and on a wait for a URL"],
  ];
  for (const [line, why] of variants) assert.equal(specLint(spec(line), PW).length, 1, why);
  const split = spec("  await page", "    .waitForLoadState('networkidle')");
  assert.equal(specLint(split, PW).length, 1, "a chain a formatter split over lines");
  // The incident line as a narrow printWidth prints it: the call and its argument land apart.
  const wrapped = spec("  await page.waitForLoadState(", "    'networkidle',", "  )");
  assert.equal(specLint(wrapped, PW).length, 1, "the argument a formatter put on its own line");
  assert.match(specLint(wrapped, PW)[0], /\(`await page\.waitForLoadState\( 'networkidle',`\)/, "quoted through the end of the match, not the line the call starts on");
  const nav = spec("  await page.goto('/agents', {", "    waitUntil: 'networkidle',", "  })");
  assert.equal(specLint(nav, PW).length, 1, "a navigation whose options a formatter wrapped");
});

test("the rule sees every Playwright spec, not only the ones that import it in one syntax", () => {
  const cjs = 'const { test, expect } = require("@playwright/test");\ntest("boot", async ({ page }) => {\n  await page.waitForLoadState("networkidle");\n});\n';
  assert.equal(specLint(cjs, PW).length, 1, "a spec that requires Playwright instead of importing it");
  assert.match(specLint(cjs, PW)[0], /waits for the network to fall idle/);
  const fixture = "import { test, expect } from '../fixtures/base'\ntest('boot', async ({ page }) => {\n  await page.waitForLoadState('networkidle')\n})\n";
  assert.equal(specLint(fixture, PW, "playwright").length, 1, "a spec that takes test and expect from a repo fixture module");
  assert.deepEqual(specLint(fixture, PW), [], "without a runner the package still has to be named somewhere");
  assert.deepEqual(specLint(cjs, PW, "node-test"), [], "and a runner that is not Playwright settles it the other way");
});

test("the networkidle message names the wait to write in its place, and forbids only what the lint refuses", () => {
  const [msg] = specLint(spec('  await page.waitForLoadState("networkidle")'), PW);
  assert.match(msg, /instead — `await expect\(page\.getByRole\('heading', \{ name: 'Dashboard' \}\)\)\.toBeVisible\(\)` retries/, "the replacement is given as the thing to write");
  assert.match(msg, /rather than swapping in `page\.waitForTimeout\(\)`$/, "and the hard sleep only as the wrong swap");
  assert.match(msg, /resolves only once 500ms pass with no connection in flight/, "it says why, so the model can tell this from a style note");
  assert.match(msg, /any app that holds one open by design/, "conditional: the rule runs against repos with no stream at all");
  assert.doesNotMatch(msg, /waitForLoadState\('load'\)/, "which the lint itself accepts, so forbidding it would leave no coherent instruction");
});

test("the load states that do settle are left alone, and the word is not the wait", () => {
  for (const line of [
    "  await page.waitForLoadState()",
    "  await page.waitForLoadState('domcontentloaded')",
    "  await page.waitForLoadState('load')",
    "  await page.goto('/agents', { waitUntil: 'domcontentloaded' })",
    "  await expect(page.getByTestId('mode')).toHaveText('networkidle')",
    "  const tip = \"page.waitForLoadState('networkidle') is only for debugging\"",
    "  // await page.waitForLoadState('networkidle')",
    "  await page.waitForLoadState('load') // not 'networkidle', that never settles",
    "  await expect(page.getByRole('heading')).toBeVisible() // replaces page.waitForLoadState(\"networkidle\")",
    "  await page.goto('/', { waitUntil: 'load' }) /* never 'networkidle' here */",
    "  type Nav = { waitUntil: 'load' | 'networkidle' }",
    "  const open = (page: Page, path: string, waitUntil: 'load' | 'networkidle' = 'load') => page.goto(path, { waitUntil })",
    "  await page.route('**/api/settings', (r) => r.fulfill({ json: { waitUntil: 'networkidle' } }))",
    "  for (const m of ['load', 'networkidle']) await page.goto(`/s?m=${m}`, { waitUntil: 'load' })",
    "  await page.goto('/s', { waitUntil: 'load' }); await expect(page.getByRole('combobox')).toHaveValue('networkidle')",
  ])
    assert.deepEqual(specLint(spec(line), PW), [], line);
  // The shape the model writes after being told what not to use: the note is not the wait.
  const jsdoc = spec(
    "/**",
    " * [c3] The dashboard renders for a signed-in user.",
    " * Does not use page.waitForLoadState('networkidle') - the app holds an SSE stream open.",
    " */",
    "  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()"
  );
  assert.deepEqual(specLint(jsdoc, PW), [], "a JSDoc header naming the rule it obeys");
  const afterArrow = spec("const settle = async (page) =>", "  // page.waitForLoadState('networkidle') never resolves here", "  expect(page.getByRole('main')).toBeVisible()");
  assert.deepEqual(specLint(afterArrow, PW), [], "a comment the line above it would otherwise splice into code");
});

test("the fixed sleep the model reaches for instead is named too, as a nudge rather than a refusal", () => {
  const sleep = spec("  await page.waitForTimeout(3000)");
  assert.match(specLint(sleep, PW)[0], /^it sleeps for a fixed time \(`await page\.waitForTimeout\(3000\)`\)/);
  assert.match(specLint(sleep, PW)[0], /toBeVisible\(\)/, "it names the retrying wait to write instead");
  assert.equal(specLint(spec("  await new Promise((r) => setTimeout(r, 3000))"), PW).length, 1, "the same sleep spelled out");
  assert.deepEqual(specLint(spec("  await expect(page.getByRole('main')).toBeVisible({ timeout: 10_000 })"), PW), [], "a retrying wait given a longer budget is not a sleep");
  assert.deepEqual(specLintCertain(sleep), [], "told once: a sleep is a flake, not a wait that can never return");
});

test("the wait that can never return is refused on every answer; every other pattern is a nudge", () => {
  const idle = spec('  await page.waitForLoadState("networkidle");');
  assert.equal(specLintCertain(idle).length, 1, "so a repair that fixes something else and keeps the wait is still refused");
  assert.deepEqual(specLintCertain(idle), [specLint(idle, PW)[0]], "the same message either way");
  assert.deepEqual(specLintCertain(spec("  await page.getByRole('group', { name: 'Edge from a to b' }).click()"), "playwright"), [], "a spec that insists on clicking a line may still be right");
  assert.deepEqual(specLintCertain(spec("  await page.getByRole('option').first().click()")), [], "and so may a page-wide role query");
  assert.deepEqual(specLintCertain("import { it } from 'vitest'\nawait page.waitForLoadState('networkidle')\n"), [], "not a Playwright spec");
});

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
