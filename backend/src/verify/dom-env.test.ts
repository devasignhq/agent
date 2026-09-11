// Offline: a generated vitest test that renders into a DOM runs in one.
//   node --import tsx/esm --test src/verify/dom-env.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDomEnvironment } from "./dom-env.js";

// The live miss: react-dom's createRoot, no docblock, a Vite config with no test block.
const rendered = "// criteria: [2]\nimport { createRoot } from 'react-dom/client'\nconst root = createRoot(document.createElement('div'))\n";
const vite = "export default defineConfig({ plugins: [react()] })\n";
const opts = { runner: "vitest" as const, dependencies: ["vitest", "happy-dom"], config: vite };

test("a vitest test that renders, where the config sets no DOM environment, is given the repo's DOM library", () => {
  assert.equal(withDomEnvironment(rendered, opts), `// @vitest-environment happy-dom\n${rendered}`);
  assert.match(withDomEnvironment(rendered, { ...opts, dependencies: ["vitest", "jsdom"] }), /^\/\/ @vitest-environment jsdom\n/);
  assert.match(withDomEnvironment(rendered, { ...opts, config: undefined }), /^\/\/ @vitest-environment happy-dom\n/, "no config at all is vitest's node default");
  assert.match(
    withDomEnvironment(rendered, { ...opts, config: "export default defineConfig({ test: { environment: 'node' } })" }),
    /^\/\/ @vitest-environment happy-dom\n/,
    "a config that names node still leaves the test without a DOM"
  );
  assert.match(withDomEnvironment("import { render, screen } from '@testing-library/react'\n", opts), /^\/\/ @vitest-environment happy-dom\n/);
});

test("left alone: a declared environment, a config that sets a DOM one, no DOM use, no DOM library, another runner", () => {
  const declared = `// @vitest-environment node\n${rendered}`;
  assert.equal(withDomEnvironment(declared, opts), declared, "the writer's own choice stands");
  assert.equal(withDomEnvironment(rendered, { ...opts, config: 'export default { test: { environment: "jsdom" } }' }), rendered);
  const server = "import { renderToStaticMarkup } from 'react-dom/server'\nexpect(renderToStaticMarkup(<A />)).toContain('x')\n";
  assert.equal(withDomEnvironment(server, opts), server, "server rendering needs no DOM");
  assert.equal(withDomEnvironment(rendered, { ...opts, dependencies: ["vitest"] }), rendered, "no DOM library to name");
  assert.equal(withDomEnvironment(rendered, { ...opts, runner: "jest" }), rendered);
});
