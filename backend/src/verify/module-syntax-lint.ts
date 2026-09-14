// A file the runner loads as an ES module dies on its first require() before any assertion runs.
import type { TestRunner } from "./contract.js";

const ESM_LOADED = new Set<TestRunner>(["node-test", "bundled", "vitest"]);
const JS_TS = /\.[jt]sx?$/;
const REQUIRE = /(?:^|[^.\w$])require(?:\.resolve)?[ \t]*\(/;
const EXPORTS = /^[ \t]*(?:module\.exports\b|exports\.[A-Za-z_$][\w$]*[ \t]*=[^=])/;
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^\\`])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
// Blanked, not removed, so line numbers still line up with the source.
const blank = (s: string) => s.replace(/[^\n]/g, " ");

/** A generated JS/TS test written in CommonJS for a runner that loads it as an ES module; empty otherwise. */
export function moduleSyntaxLint(path: string, content: string, runner?: TestRunner): string[] {
  if (!JS_TS.test(path) || (runner && !ESM_LOADED.has(runner))) return [];
  const code = content.replace(COMMENT_OR_STRING, blank).split("\n").map((l) => l.replace(/\/\/.*$/, ""));
  const createsRequire = code.some((l) => /\bcreateRequire[ \t]*\(/.test(l));
  const hit = code.findIndex((l) => EXPORTS.test(l) || (!createsRequire && REQUIRE.test(l)));
  if (hit < 0) return [];
  const line = content.split("\n")[hit].trim().slice(0, 120);
  return [`it uses CommonJS syntax (\`${line}\`) in a file the runner loads as an ES module, so it fails before its first assertion; rewrite it with \`import\`/\`export\` only`];
}
