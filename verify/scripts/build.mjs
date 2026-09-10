// Bundles the CLI and asserts the bundle reports the version it was published as.
// 1.3.0 shipped announcing itself as 1.2.0 because that string was hand-maintained
// beside package.json; the define below is now the only source of it.
import { chmodSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = "dist/cli.js";

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: out,
  external: ["tsx", "@playwright/test"],
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
  // Collapses `typeof "x" === "string" ? "x" : fallback()` to the literal. Without it
  // the dead branch survives, calling a fallback tree-shaking has already removed.
  minifySyntax: true,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

const bundle = readFileSync(out, "utf8");
const fail = (why) => {
  console.error(`build: ${why}`);
  process.exit(1);
};
if (!bundle.includes(JSON.stringify(pkg.version))) fail(`${out} does not carry version ${pkg.version}`);
// The fallback reads package.json relative to the source tree, which does not exist
// beside the published bundle. Surviving the fold would make every run throw.
if (bundle.includes("../package.json")) fail(`${out} kept the tsx-only manifest fallback`);
if (bundle.includes("manifestVersion")) fail(`${out} still references the folded-away fallback`);

chmodSync(out, 0o755);
console.log(`built ${out} — @devasign/verify ${pkg.version}`);
