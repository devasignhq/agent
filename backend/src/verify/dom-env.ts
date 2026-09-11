// Under vitest's default node environment a test that renders into a DOM dies on `document is not
// defined`. Shown a config that sets no environment, writers still left the docblock out — all three
// component fallbacks on fundsflow PR 23 — and the fix is mechanical, so it is made here.
import type { TestRunner } from "./contract.js";

const USES_DOM = /\b(?:document|window)\.|\bcreateRoot\s*\(|["'](?:react-dom\/client|@testing-library\/(?:react|dom|preact|vue|svelte|user-event))["']/;
const DECLARED = /@(?:vitest|jest)-environment\s/;
const CONFIG_DOM = /\benvironment\s*:\s*["'`](?:jsdom|happy-dom)["'`]/;
// Either renders a component; happy-dom is the lighter of the two.
const DOM_LIBRARIES = ["happy-dom", "jsdom"];

/** The file with a DOM environment declared, when it renders into one its runner would not give it. */
export function withDomEnvironment(content: string, opts: { runner: TestRunner; dependencies: readonly string[]; config?: string }): string {
  if (opts.runner !== "vitest" || DECLARED.test(content) || !USES_DOM.test(content)) return content;
  // A config that names `node` still leaves a rendering test without a DOM; only a DOM one covers it.
  if (opts.config && CONFIG_DOM.test(opts.config)) return content;
  const env = DOM_LIBRARIES.find((d) => opts.dependencies.includes(d));
  return env ? `// @vitest-environment ${env}\n${content}` : content;
}
