// Offline: which characters the import rewriter is allowed to touch.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/verify/code-spans.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeSpans, isRewritableSpecifier } from "./code-spans.js";

// Where `src` has exactly one occurrence of `quoted`, is it a literal in code?
function literalAt(src: string, quoted: string): boolean {
  const at = src.indexOf(quoted);
  assert.notEqual(at, -1, `fixture missing ${quoted}`);
  const spans = codeSpans(src);
  return spans.literals.get(at) === at + quoted.length - 1;
}

test("strings, comments and template text are not code; holes and ordinary source are", () => {
  const src = 'const a = "x"; // b\nconst c = `t${ d }`;\n/* e */ const f = 1;';
  const { code } = codeSpans(src);
  const at = (needle: string) => code[src.indexOf(needle)];
  assert.equal(at("const a"), 1);
  assert.equal(at('"x"'), 0, "the string and its quotes are not code");
  assert.equal(at("// b"), 0);
  assert.equal(at("t$"), 0, "template text is not code");
  assert.equal(at(" d "), 1, "the inside of a ${} hole is code");
  assert.equal(at("/* e */"), 0);
  assert.equal(at("const f"), 1);
});

test("a literal's span is recorded from its opening quote to its closer", () => {
  assert.ok(literalAt('import x from "./a.js";', '"./a.js"'));
  assert.ok(literalAt("import x from './a.js';", "'./a.js'"));
  assert.ok(literalAt("const m = await import(`./a.js`);", "`./a.js`"), "a template with no hole is a literal");
  assert.ok(!literalAt('const s = "outer \\" ./a.js";', '" ./a.js"'), "an escaped quote does not open a literal");
});

test("a quote inside another literal is not a literal of its own", () => {
  // The proven false positive: the inner specifier is data, not an import.
  const src = `expect(e.message).toBe('cannot find module require("./total.js")');`;
  const spans = codeSpans(src);
  const inner = src.indexOf('"./total.js"');
  assert.equal(spans.literals.has(inner), false);
  assert.equal(spans.code[inner], 0);
  assert.equal(spans.literals.get(src.indexOf("'cannot")), src.lastIndexOf("'"), "the outer string is the literal");
});

test("an import nested in a multi-line template is template text, not a statement", () => {
  // The second proven site: branch 1's lead can span newlines.
  const src = ["const source = `", 'import x from "./a.js";', "`;", 'import { y } from "./b.js";'].join("\n");
  const spans = codeSpans(src);
  assert.equal(spans.code[src.indexOf('import x from "./a.js"')], 0, "inside the template");
  assert.equal(spans.code[src.indexOf('import { y }')], 1, "the real statement after it");
  assert.ok(spans.literals.has(src.indexOf('"./b.js"')));
  assert.equal(spans.literals.has(src.indexOf('"./a.js"')), false);
});

test("nested templates and their holes nest correctly", () => {
  const src = "const v = `a${ `b${ c }d` }e`;";
  const { code, literals } = codeSpans(src);
  assert.equal(code[src.indexOf(" c ") + 1], 1, "the inner hole is code");
  assert.equal(code[src.indexOf("d`")], 0, "the inner template's text is not");
  assert.equal(code[src.indexOf("e`")], 0, "back in the outer template's text");
  assert.equal(literals.get(src.indexOf("`a$")), src.lastIndexOf("`"), "the outer template spans the whole thing");
});

test("a regex body is not code, and its quotes cannot desynchronise the scan", () => {
  const src = 'const q = /["\']/;\nimport { x } from "./total.js";';
  const spans = codeSpans(src);
  assert.equal(spans.code[src.indexOf('["')], 0, "the regex body");
  assert.ok(spans.literals.has(src.indexOf('"./total.js"')), "the import after it is still seen");
});

test("division is not mistaken for a regex", () => {
  for (const line of ["const r = a / b;", "const h = (a + b) / 2;", "const k = arr[0] / 2;"]) {
    const src = `${line}\nimport { x } from "./total.js";`;
    assert.ok(codeSpans(src).literals.has(src.indexOf('"./total.js"')), line);
  }
});

test("an unterminated quote reverts to code at the newline instead of swallowing the file", () => {
  const src = "const el = <p>don't</p>;\nimport { x } from \"./total.js\";";
  assert.ok(codeSpans(src).literals.has(src.indexOf('"./total.js"')), "a JSX apostrophe must not eat the next line");
});

test("an unterminated template marks the tail non-code rather than rewriting blind", () => {
  const src = 'const t = `oops\nimport { x } from "./total.js";';
  const spans = codeSpans(src);
  assert.equal(spans.code[src.indexOf("import")], 0);
  assert.equal(spans.literals.has(src.indexOf('"./total.js"')), false);
});

test("isRewritableSpecifier accepts a real statement and rejects both false-positive sites", () => {
  const ok = 'import { x } from "./total.js";';
  const lead = 'import { x } from ';
  assert.equal(isRewritableSpecifier(codeSpans(ok), 0, lead, "./total.js"), true);

  const nested = `expect(e).toBe('require("./total.js")');`;
  const at = nested.indexOf('require("');
  assert.equal(isRewritableSpecifier(codeSpans(nested), at, 'require(', "./total.js"), false);

  const inTemplate = ['const s = `', 'import x from "./a.js";', "`;"].join("\n");
  const stmt = inTemplate.indexOf("\nimport x");
  assert.equal(isRewritableSpecifier(codeSpans(inTemplate), stmt, '\nimport x from ', "./a.js"), false);
});
