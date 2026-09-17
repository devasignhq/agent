// Which bare package specifiers a generated test may use. The runner installs nothing
// into the customer's repo, so an import of a package they do not have is a suite that
// never loads — and, before classify.ts learned vitest's wording, a false red.
//
// Fails open on purpose: without a dependency list we allow everything, because a
// dropped legitimate test costs more than the bug this guards against.
import { builtinModules } from "node:module";
import { posix } from "node:path";
import { codeSpans, isRewritableSpecifier } from "./code-spans.js";
import type { DetectedSetup, TestRunner } from "./contract.js";

// Shared with plan.ts's relative-import rewriter: the two scanners must never disagree
// about what a specifier looks like.
export const IMPORT_LEAD = [
  String.raw`(?:^|\n)[ \t]*(?:import|export)[^'"\`]*?\bfrom\s*`,
  String.raw`(?:^|\n)[ \t]*import\s*`,
  String.raw`\b(?:import|require(?:\.resolve)?)\s*\(\s*`,
  String.raw`\b(?:\w+\.)*(?:mock\.module|unstable_mockModule|(?:create|gen)MockFromModule|deepUnmock|(?:do|un|set|dont|doUn)?[Mm]ock|(?:import|require)(?:Actual|Mock))\s*\(\s*`,
].join("|");

const BARE_IMPORT = new RegExp(`(${IMPORT_LEAD})(['"\`])([^'"\`\\n]+)\\2`, "g");
const BUILTINS = new Set(builtinModules);
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
// A framework's own DOM renderer mounts components without a testing library (react-dom's
// createRoot inside act), so it counts when a DOM environment is installed beside it.
const RENDER_LIBS = ["@testing-library/react", "@testing-library/vue", "@testing-library/svelte", "@testing-library/preact", "@testing-library/angular", "@testing-library/dom", "@vue/test-utils", "enzyme", "react-dom", "preact"];
const DOM_ENVS = ["jsdom", "happy-dom", "jest-environment-jsdom", "@happy-dom/global-registrator"];

export type ImportAllowList = { names: ReadonlySet<string>; enforce: boolean };

/** The package a specifier resolves from: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. */
export function packageRoot(spec: string): string | null {
  const parts = spec.split("/");
  const root = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return root.length <= 214 && NPM_NAME.test(root) ? root : null;
}

export function buildImportAllowList(setup: DetectedSetup, runner: TestRunner): ImportAllowList {
  const names = new Set(setup.dependencies ?? []);
  // Supplied by the runner rather than the repo: playwright is symlinked into
  // .devasign/node_modules, and tsx loads the node-test files.
  for (const n of ["@playwright/test", "playwright", "playwright-core", "tsx"]) names.add(n);
  for (const f of setup.frameworks) {
    if (f.name === "vitest") names.add("vitest");
    if (f.name === "jest") for (const n of ["jest", "@jest/globals"]) names.add(n);
  }
  return { names, enforce: setup.dependencies != null && runner !== "pytest" && runner !== "go" };
}

export function hasRenderStack(setup: DetectedSetup): boolean {
  // Unknown dependencies must not close a rung that is open today.
  if (setup.dependencies == null) return true;
  const has = (n: string) => setup.dependencies!.includes(n);
  const domCapable = setup.frameworks.some((f) => f.name === "vitest" || f.name === "jest");
  return domCapable && RENDER_LIBS.some(has) && DOM_ENVS.some(has);
}

const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json"];

export const withoutExt = (p: string): string => p.replace(/\.[cm]?[jt]sx?$/, "");

/** Whether a repository path names a file, allowing the extension swaps a loader makes. */
export function resolvesInRepo(target: string, exists: (p: string) => boolean): boolean {
  const stem = withoutExt(target);
  return [target, ...RESOLVE_EXTS.map((e) => stem + e), ...RESOLVE_EXTS.map((e) => `${target}/index${e}`)].some(exists);
}

export type ImportTargetOpts = {
  // Other generated files in the same plan, keyed by extensionless origin path: they
  // move too, so a specifier pointing at one follows it.
  siblings?: ReadonlyMap<string, string>;
  // The repository as the runner will see it. Without it a specifier that climbs past
  // the root cannot be told from one that means to.
  exists?: (p: string) => boolean;
};
export type ImportTarget = { target: string } | { reason: "interpolated" | "above_root" };

/** The repository file a relative specifier written in `fromDir` points at. The rewriter ships
 *  posix.relative(toDir, target) and the validator checks this target, so what ships is checked. */
export function importTarget(spec: string, fromDir: string, opts: ImportTargetOpts = {}): ImportTarget {
  if (spec.includes("${")) return { reason: "interpolated" };
  let target = posix.normalize(posix.join(fromDir, spec));
  // A climb past the root is a miscount — the root is the ceiling — so clamp, but only onto
  // a file that is there: one meaning somewhere outside the checkout keeps pointing there.
  if (target.startsWith("..")) {
    const clamped = target.replace(/^(?:\.\.\/)+/, "");
    const known = !!clamped && !clamped.startsWith("..") && (opts.siblings?.has(withoutExt(clamped)) || (!!opts.exists && resolvesInRepo(clamped, opts.exists)));
    if (!known) return { reason: "above_root" };
    target = clamped;
  }
  const moved = opts.siblings?.get(withoutExt(target));
  // Keep the specifier's own basename (the model may write .js for a .ts file).
  return { target: moved ? posix.join(posix.dirname(moved), posix.basename(target)) : target };
}

/** Relative specifiers that reach no repository file from where the test will actually run. */
export function unresolvedRelativeImports(
  content: string,
  fromPath: string,
  exists: (p: string) => boolean,
  siblings?: ReadonlyMap<string, string>
): string[] {
  const spans = codeSpans(content);
  const dir = posix.dirname(fromPath.replace(/^\.\//, ""));
  const missing = new Set<string>();
  for (const m of content.matchAll(BARE_IMPORT)) {
    const [, lead, , spec] = m;
    if (!isRewritableSpecifier(spans, m.index, lead, spec)) continue;
    if (/\b(?:import|export)\s+type\b/.test(lead)) continue;
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    const t = importTarget(spec, dir, { siblings, exists });
    if (!("target" in t) || !resolvesInRepo(t.target, exists)) missing.add(spec);
  }
  return [...missing];
}

/** Package roots the content imports that the repo cannot resolve. Empty when not enforcing. */
export function disallowedImports(content: string, allow: ImportAllowList): string[] {
  if (!allow.enforce) return [];
  const spans = codeSpans(content);
  const bad = new Set<string>();
  for (const m of content.matchAll(BARE_IMPORT)) {
    const [, lead, , spec] = m;
    if (!isRewritableSpecifier(spans, m.index, lead, spec)) continue;
    // Erased before runtime, so it can never fail to load.
    if (/\b(?:import|export)\s+type\b/.test(lead)) continue;
    // Relative, protocol, virtual, subpath-import and bundler-alias specifiers are
    // either someone else's problem or unresolvable from names alone.
    if (/^[./#~]|^[a-zA-Z]:[\\/]|:\/\//.test(spec) || spec.startsWith("@/") || spec.startsWith("data:")) continue;
    if (spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0])) continue;
    const root = packageRoot(spec);
    if (root && !allow.names.has(root)) bad.add(root);
  }
  return [...bad];
}
