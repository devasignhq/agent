// DATABASE_URL= node --import tsx/esm --test src/verify/module-syntax-lint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { moduleSyntaxLint } from "./module-syntax-lint.js";

const P = ".devasign/tests/total.test.ts";
const ESM = 'import test from "node:test";\n';
const CJS = 'const { test } = require("node:test");\n';

test("a generated test written in CommonJS is told once, with its line, to use import/export", () => {
  const live = ["// criteria 1", 'const { test } = require("node:test");', 'const { total } = require("../../src/total.js");', 'test("total", () => {});'].join("\n");
  const problems = moduleSyntaxLint(P, live);
  assert.equal(problems.length, 1, "one message per file");
  assert.match(problems[0], /CommonJS syntax \(`const \{ test \} = require\("node:test"\);`\)/);
  assert.match(problems[0], /loads as an ES module[\s\S]*rewrite it with `import`\/`export` only/);
  assert.equal(moduleSyntaxLint(P, 'const pkg = require.resolve("vitest");\n').length, 1);
  assert.equal(moduleSyntaxLint(P, `${ESM}module.exports = { a: 1 };\n`).length, 1);
  assert.equal(moduleSyntaxLint(P, `${ESM}exports.total = () => 1;\n`).length, 1);
  assert.deepEqual(moduleSyntaxLint(P, ESM), []);
  for (const runner of ["node-test", "bundled", "vitest"] as const) assert.equal(moduleSyntaxLint(P, CJS, runner).length, 1, runner);
});

test("a require() that is quoted, commented out, or made by createRequire is not CommonJS", () => {
  assert.deepEqual(moduleSyntaxLint(P, `${ESM}test("x", () => assert.ok(!src.includes('require("./pill")')));\n`), []);
  assert.deepEqual(moduleSyntaxLint(P, `${ESM}const src = \`\n  const x = require("y");\n\`;\n`), []);
  assert.deepEqual(moduleSyntaxLint(P, `${ESM}// const x = require("y");\n/* module.exports = 1 */\n`), []);
  assert.deepEqual(moduleSyntaxLint(P, 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconst x = require("y");\n'), []);
  assert.deepEqual(moduleSyntaxLint(P, `${ESM}exports.total.push(1);\nif (a.exports === b) {}\n`), []);
  // The quoted line is what the author reads back, with the strings it wrote.
  assert.match(moduleSyntaxLint(P, `${ESM}const t = "esm"; const { x } = require("../../src/x.js");\n`)[0], /`const t = "esm"; const \{ x \} = require\("\.\.\/\.\.\/src\/x\.js"\);`/);
});

test("only files the runner loads as ES modules are held to it", () => {
  assert.deepEqual(moduleSyntaxLint(".devasign/tests/a.test.cts", CJS), []);
  assert.deepEqual(moduleSyntaxLint(".devasign/tests/a.test.cjs", CJS), []);
  assert.deepEqual(moduleSyntaxLint(".devasign/tests/a_test.py", "import os\n"), []);
  assert.deepEqual(moduleSyntaxLint(P, CJS, "jest"), []);
  assert.deepEqual(moduleSyntaxLint(P, CJS, "playwright"), []);
});
