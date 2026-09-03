// Everything we write lives under <repo>/.devasign and is removed at the end.
// The customer's files — package.json, lockfiles, their Playwright config — are
// never touched.
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEVASIGN_DIR = ".devasign";

export class Workspace {
  readonly root: string;
  readonly dir: string;
  readonly artifactsDir: string;
  readonly testsDir: string;
  private created: string[] = [];
  private preexistingDir: boolean;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, DEVASIGN_DIR);
    this.artifactsDir = path.join(this.dir, "artifacts");
    this.testsDir = path.join(this.dir, "tests");
    this.preexistingDir = existsSync(this.dir);
    // A previous interrupted or --keep run must not leak state into this one.
    for (const sub of ["tests", "artifacts", "node_modules", "playwright.config.ts", "playwright.existing.config.ts"]) {
      rmSync(path.join(this.dir, sub), { recursive: true, force: true });
    }
  }

  /** Absolute path for a repo-relative path, refusing anything outside `.devasign/`. */
  resolveOwned(rel: string): string {
    const full = path.resolve(this.root, rel);
    if (!full.startsWith(this.dir + path.sep)) throw new Error(`refusing to write outside ${DEVASIGN_DIR}/: ${rel}`);
    return full;
  }

  write(rel: string, content: string): string {
    const full = this.resolveOwned(rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    this.created.push(full);
    return full;
  }

  ensureDir(rel: string): string {
    const full = this.resolveOwned(rel);
    mkdirSync(full, { recursive: true });
    this.created.push(full);
    return full;
  }

  /** Expose a package from our own install to files under `.devasign/` (never into the repo's node_modules). */
  linkPackage(name: string, target: string): void {
    const link = this.resolveOwned(path.join(DEVASIGN_DIR, "node_modules", name));
    if (existsSync(link)) return;
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, "junction");
    this.created.push(link);
  }

  relative(full: string): string {
    return path.relative(this.root, full).split(path.sep).join("/");
  }

  /** Remove what we created. A pre-existing `.devasign/` (hooks, config) stays. */
  cleanup(): void {
    for (const p of [...this.created].reverse()) rmSync(p, { recursive: true, force: true });
    for (const sub of ["tests", "artifacts", "node_modules"]) rmSync(path.join(this.dir, sub), { recursive: true, force: true });
    if (!this.preexistingDir) rmSync(this.dir, { recursive: true, force: true });
    this.created = [];
  }
}
