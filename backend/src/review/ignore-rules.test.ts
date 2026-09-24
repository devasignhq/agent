// node --import tsx/esm --test src/review/ignore-rules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIgnore } from "./ignore-rules.js";

const root = (content: string) => ({ path: ".gitignore", content });

test("an unanchored root pattern matches at any depth, with git's source:line", () => {
  const m = checkIgnore("backend/deploy/gcp/.env.cloudrun.yaml", [root("node_modules\n.env\n.env.*\n!.env.example\n")]);
  assert.deepEqual(m, { ignored: true, source: ".gitignore", line: 3, pattern: ".env.*" });
});

test("a later negation re-includes the file", () => {
  const m = checkIgnore("backend/.env.example", [root(".env.*\n!.env.example\n")]);
  assert.equal(m?.ignored, false);
  assert.equal(m?.line, 2);
});

test("no matching rule → null", () => {
  assert.equal(checkIgnore("src/app.ts", [root(".env.*\n*.pem\n")]), null);
});

test("comments, blanks and trailing spaces are skipped", () => {
  const m = checkIgnore("x.log", [root("# logs\n\n*.log   \n")]);
  assert.equal(m?.line, 3);
});

test("a pattern with a slash is anchored to its .gitignore's directory", () => {
  const files = [root("/build\ndocs/out\n")];
  assert.equal(checkIgnore("build/app.js", files)?.ignored, true);
  assert.equal(checkIgnore("pkg/build/app.js", files), null);
  assert.equal(checkIgnore("docs/out/index.html", files)?.ignored, true);
  assert.equal(checkIgnore("pkg/docs/out/index.html", files), null);
});

test("a trailing slash only matches directories", () => {
  const files = [root("dist/\n")];
  assert.equal(checkIgnore("dist/main.js", files)?.ignored, true);
  assert.equal(checkIgnore("dist", files), null);
});

test("** spans directories", () => {
  const files = [root("**/secrets/*.json\nlogs/**\na/**/z.txt\n")];
  assert.equal(checkIgnore("secrets/k.json", files)?.ignored, true);
  assert.equal(checkIgnore("x/y/secrets/k.json", files)?.ignored, true);
  assert.equal(checkIgnore("logs/2026/app.log", files)?.ignored, true);
  assert.equal(checkIgnore("a/z.txt", files)?.ignored, true);
  assert.equal(checkIgnore("a/b/c/z.txt", files)?.ignored, true);
});

test("a nested .gitignore overrides the root and only applies below itself", () => {
  const files = [root("*.yaml\n"), { path: "config/.gitignore", content: "!keep.yaml\n" }];
  assert.equal(checkIgnore("config/keep.yaml", files)?.ignored, false);
  assert.equal(checkIgnore("other/keep.yaml", files)?.ignored, true);
});

test("a file inside an excluded directory cannot be re-included", () => {
  const m = checkIgnore("build/keep.txt", [root("build/\n!build/keep.txt\n")]);
  assert.equal(m?.ignored, true);
  assert.equal(m?.pattern, "build/");
});

test("anchored mode (.dockerignore) does not match basenames at depth", () => {
  const files = [{ path: "backend/.dockerignore", content: ".env*\nnode_modules\n" }];
  assert.equal(checkIgnore("backend/.env.local", files, "anchored")?.ignored, true);
  assert.equal(checkIgnore("backend/deploy/.env.local", files, "anchored"), null);
});

test("paths escaping the repo are never matched", () => {
  assert.equal(checkIgnore("../.env", [root(".env\n")]), null);
});
