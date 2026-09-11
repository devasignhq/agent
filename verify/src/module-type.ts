// A generated test is relocated under .devasign/tests/, so its module scope is the
// repo root's rather than its target's. Declare the scope its own syntax needs.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlanTest } from "./types.js";
import type { Workspace } from "./workspace.js";

export type ModuleType = "module" | "commonjs";
export type ModuleTypeShim = { dir: string; type: ModuleType };

// .mjs/.cjs/.mts/.cts already carry their format; .py and .go have no scope to set.
const SCOPED_EXT = /\.[jt]sx?$/;

const ESM_SYNTAX = /^[ \t]*(?:import|export)(?:[ \t]+[A-Za-z_$*{"']|[ \t]*[{*"'])/m;
const CJS_SYNTAX = /(?:^|[^.\w$])require[ \t]*\(|^[ \t]*(?:module\.exports\b|exports\.[A-Za-z_$])/m;

// These tests quote module source at themselves, so a template literal opening a
// line with `import` would otherwise read as the file's own syntax.
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``");
}

/** The scope a file's own syntax requires, or null when either one would load it. */
export function detectModuleSyntax(source: string): ModuleType | null {
  const code = stripNonCode(source);
  // A top-level import or export settles it: no CJS form can coexist with one.
  if (ESM_SYNTAX.test(code)) return "module";
  return CJS_SYNTAX.test(code) ? "commonjs" : null;
}

/** The scope a directory sits in, read the way Node reads it: nearest package.json wins. */
export function inheritedModuleType(root: string, dirRel: string): ModuleType {
  const stop = path.resolve(root);
  for (let dir = path.resolve(root, dirRel); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        return (JSON.parse(readFileSync(manifest, "utf8")) as { type?: unknown }).type === "module" ? "module" : "commonjs";
      } catch {
        return "commonjs";
      }
    }
    if (dir === stop || path.dirname(dir) === dir) return "commonjs";
  }
}

const posixDir = (p: string): string => path.posix.dirname(p.split(path.sep).join("/"));

function scopeOf(root: string, dir: string, decided: ReadonlyMap<string, ModuleType>): ModuleType {
  for (let d = dir; d && d !== "." && d !== "/"; d = path.posix.dirname(d)) {
    const shim = decided.get(d);
    if (shim) return shim;
  }
  return inheritedModuleType(root, dir);
}

/**
 * The package.json files that make relocated tests load as written. Playwright specs
 * ask only to keep the scope they have, so a sibling shim cannot move them.
 */
export function planModuleTypeShims(root: string, tests: readonly Pick<PlanTest, "path" | "content" | "origin" | "runner">[]): ModuleTypeShim[] {
  const wanted = new Map<string, Map<ModuleType, number>>();
  for (const t of tests) {
    if (t.origin !== "generated" || !SCOPED_EXT.test(t.path)) continue;
    const dir = posixDir(t.path);
    const needs = t.runner === "playwright" ? inheritedModuleType(root, dir) : t.content ? detectModuleSyntax(t.content) : null;
    if (!needs) continue;
    const counts = wanted.get(dir) ?? new Map<ModuleType, number>();
    counts.set(needs, (counts.get(needs) ?? 0) + 1);
    wanted.set(dir, counts);
  }
  const decided = new Map<string, ModuleType>();
  const shims: ModuleTypeShim[] = [];
  // Shallow first: a shim covers every directory below it, so it has to be in
  // place before the ones it might move are judged.
  for (const dir of [...wanted.keys()].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    const counts = wanted.get(dir)!;
    // One directory, one format. A mixture goes to ESM, the format a `.ts` in a
    // CommonJS scope has no way to fall back to.
    const type: ModuleType = (counts.get("module") ?? 0) >= (counts.get("commonjs") ?? 0) ? "module" : "commonjs";
    if (scopeOf(root, dir, decided) === type) continue;
    decided.set(dir, type);
    shims.push({ dir, type });
  }
  return shims;
}

export function writeModuleTypeShims(ws: Workspace, tests: readonly Pick<PlanTest, "path" | "content" | "origin" | "runner">[]): ModuleTypeShim[] {
  const shims = planModuleTypeShims(ws.root, tests);
  for (const s of shims) ws.write(path.posix.join(s.dir, "package.json"), `${JSON.stringify({ type: s.type })}\n`);
  return shims;
}
