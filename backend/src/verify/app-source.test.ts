// Offline: what a browser test's author is shown of the running app.
//   node --import tsx/esm --test src/verify/app-source.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { appSourceFor, entryPaths, localImports, persistKey, sourceUnderTest, waysIn } from "./app-source.js";

const files: Record<string, string> = {
  "index.html": '<div id="root"></div>\n<script type="module" src="/src/main.tsx"></script>\n',
  "src/main.tsx": "import App from './App'\nimport './styles.css'\n",
  "src/App.tsx": "import { Canvas } from './components/Canvas'\nimport { Palette } from './components/Palette'\nimport { store } from './store'\n",
  "src/components/Canvas.tsx": "import { Pill } from './Pill'\n",
  "src/components/Palette.tsx": "export function Palette() {}\n",
  "src/components/Pill.tsx": "import { Deep } from './Deep'\n",
  "src/components/Deep.tsx": "import { Deeper } from './Deeper'\n",
  "src/components/Deeper.tsx": "export const Deeper = 1\n",
  "src/components/Canvas.test.tsx": "import { Canvas } from './Canvas'\n",
  "src/store/index.ts": "export const store = {}\n",
  "src/styles.css": "",
};
const tree = new Set(Object.keys(files));
const read = async (p: string) => files[p] ?? null;

test("entryPaths: the module index.html loads, else the first conventional entry present", () => {
  assert.deepEqual(entryPaths(tree, files["index.html"]), ["src/main.tsx"]);
  assert.deepEqual(entryPaths(new Set(["app/page.tsx", "src/App.tsx"]), null), ["app/page.tsx"]);
  assert.deepEqual(entryPaths(new Set(["src/App.tsx"]), "<script src='/missing.js'></script>"), []);
});

test("localImports resolves relative specifiers to tree paths: extensionless, index files, .js for .ts", () => {
  assert.deepEqual(localImports("src/App.tsx", files["src/App.tsx"], tree), ["src/components/Canvas.tsx", "src/components/Palette.tsx", "src/store/index.ts"]);
  assert.deepEqual(localImports("src/a.ts", "import { x } from './store/index.js'\nimport 'react'\nconst l = import('./components/Pill')\n", tree), ["src/store/index.ts", "src/components/Pill.tsx"]);
  assert.deepEqual(localImports("src/a.ts", "import x from '../../outside'\n", tree), [], "nothing above the repo root");
});

test("the author sees the test's targets first, then the entry and the screens it mounts, and never a test file", async () => {
  const out = await appSourceFor({ targetFiles: ["src/components/Pill.tsx", "src/components/Canvas.test.tsx"], tree, read });
  assert.deepEqual(out.map((f) => f.path), [
    "src/components/Pill.tsx",
    "src/main.tsx",
    "src/components/Deep.tsx",
    "src/App.tsx",
    "src/components/Deeper.tsx",
    "src/components/Canvas.tsx",
    "src/components/Palette.tsx",
    "src/store/index.ts",
  ]);
  assert.ok(out.every((f) => !f.truncated));
});

test("depth, file and size limits cut the crawl, truncating rather than dropping the file that crosses them", async () => {
  const shallow = await appSourceFor({ targetFiles: [], tree, read, limits: { files: 16, fileChars: 12_000, totalChars: 90_000, depth: 1 } });
  assert.deepEqual(shallow.map((f) => f.path), ["src/main.tsx", "src/App.tsx", "src/store/index.ts"]);
  const tight = await appSourceFor({ targetFiles: [], tree, read, limits: { files: 16, fileChars: 12_000, totalChars: 60, depth: 3 } });
  assert.deepEqual(tight.map((f) => [f.path, f.truncated]), [["src/main.tsx", false], ["src/App.tsx", true]]);
  assert.equal(tight.reduce((n, f) => n + f.content.length, 0), 60);
});

// The shape of the fundsflow failure: block labels in a config module, template names in a
// data module two imports away from the menu that renders them.
const app: Record<string, string> = {
  "src/main.tsx": "import App from './App'\n",
  "src/App.tsx": "import { Palette } from './components/Palette'\nimport { TemplateMenu } from './components/TemplateMenu'\n",
  "src/components/Palette.tsx": "import { BLOCK_TYPES } from '../config/blockTypes'\n",
  "src/components/TemplateMenu.tsx": "import { TEMPLATES } from '../lib/templates'\nimport { formatMoney } from '../lib/format'\nimport { BLOCK_TYPES } from '../config/blockTypes'\n",
  "src/config/blockTypes.ts": "import type { BlockKind } from '../types'\nexport const BLOCK_TYPES = [{ label: 'Federal agency' }]\n",
  "src/lib/templates/index.ts": "import { nih } from './nih'\nexport const TEMPLATES = [nih]\n",
  "src/lib/templates/nih.ts": "export const nih = { name: 'NIH research grant' }\n",
  "src/lib/templates/templates.test.ts": "import { TEMPLATES } from './index'\n",
  "src/lib/format.ts": "export const formatMoney = String\n",
  "src/types.ts": "export type BlockKind = string\n",
};
const appTree = new Set(Object.keys(app));
const appRead = async (p: string) => app[p] ?? null;

test("labels, templates and sample data reach the author after the screens that render them", async () => {
  const out = await appSourceFor({ targetFiles: [], tree: appTree, read: appRead });
  assert.deepEqual(out.map((f) => f.path), [
    "src/main.tsx",
    "src/App.tsx",
    "src/components/Palette.tsx",
    "src/components/TemplateMenu.tsx",
    "src/config/blockTypes.ts",
    "src/lib/templates/index.ts",
    "src/lib/format.ts",
    "src/types.ts",
    "src/lib/templates/nih.ts",
  ]);
  const screensOnly = await appSourceFor({ targetFiles: [], tree: appTree, read: appRead, limits: { files: 4, fileChars: 12_000, totalChars: 90_000, depth: 8 } });
  assert.deepEqual(screensOnly.map((f) => f.path), ["src/main.tsx", "src/App.tsx", "src/components/Palette.tsx", "src/components/TemplateMenu.tsx"], "a short budget drops data before screens");
});

test("a unit or component test's author sees the runner's config, then the code it calls and what that imports, two levels down", async () => {
  const f: Record<string, string> = {
    "vitest.config.ts": "export default { test: { environment: 'node' } }\n",
    "src/lib/edgeStyle.ts": "import { EDGE_COLORS } from '../config/edgeColors'\nimport type { Line } from '../types'\n",
    "src/lib/edgeStyle.test.ts": "import './edgeStyle'\n",
    "src/config/edgeColors.ts": "import { brand } from './brand'\nexport const EDGE_COLORS = [{ name: 'Green', color: '#16a34a' }]\n",
    "src/config/brand.ts": "import { deeper } from './deeper'\nexport const brand = 1\n",
    "src/config/deeper.ts": "export const deeper = 1\n",
    "src/types.ts": "export type Line = {}\n",
  };
  const out = await sourceUnderTest({
    targetFiles: ["src/lib/edgeStyle.ts", "src/lib/edgeStyle.test.ts"],
    config: "vitest.config.ts",
    tree: new Set(Object.keys(f)),
    read: async (p) => f[p] ?? null,
  });
  assert.deepEqual(out.map((s) => s.path), ["vitest.config.ts", "src/lib/edgeStyle.ts", "src/config/edgeColors.ts", "src/types.ts", "src/config/brand.ts"]);
  assert.match(out[2].content, /#16a34a/, "the values a test would otherwise guess");
});

test("ways in: built-in collections with the screens that show them, and the keys state is saved under", () => {
  const src = (path: string, content: string) => ({ path, content, truncated: false });
  const source = [
    src("src/components/TemplateMenu.tsx", "import { TEMPLATES } from '../lib/templates'\nexport function TemplateMenu() {}\n"),
    src("src/lib/templates/index.ts", "import { sampleNodes } from '../sampleFlow'\nexport const TEMPLATES = [nih]\nexport type Template = {}\n"),
    // Seen live: listed bare, sample data read as the app's default chart, which starts empty.
    src("src/lib/sampleFlow.ts", "export const sampleNodes = []\n"),
    src("src/lib/format.ts", "export const formatMoney = String\n"),
    src("src/store/useFlow.ts", "export const useFlow = create(persist((set) => ({ charts: [] }), { name: 'flow-app' }))\n"),
    src("src/store/theme.ts", "localStorage.setItem('flow-theme', t)\nlocalStorage.getItem('flow-theme')\n"),
  ];
  const paths = new Set(source.map((f) => f.path));
  assert.deepEqual(waysIn(source, paths), [
    "## Ways into a populated state",
    "Found in the source below. Start from one of these unless a criterion is about building that data itself.",
    "- `TEMPLATES` in src/lib/templates/index.ts — shown by src/components/TemplateMenu.tsx",
    "- `sampleNodes` in src/lib/sampleFlow.ts — used by src/lib/templates/index.ts, not by any screen directly",
    '- src/store/useFlow.ts persists its store under "flow-app" (zustand `persist`)',
    '- src/store/theme.ts reads or writes localStorage "flow-theme"',
  ]);
  assert.deepEqual(waysIn([src("src/lib/format.ts", "export const formatMoney = String\n")], new Set(["src/lib/format.ts"])), [], "nothing to start from");
});

test("persistKey skips the brackets inside a regex or template literal in the creator", () => {
  // From review: a `)` in a regex character class closed the call early and lost the key.
  assert.equal(persistKey("export const useS = create(persist((set) => ({ re: /[)]/, x: 1 }), { name: 'kept' }))"), "kept");
  assert.equal(persistKey("create(persist((set) => ({ parts: (s) => s.split(/[,}]/), half: (n) => n / 2 }), { name: 'kept' }))"), "kept", "a division is not a regex");
  assert.equal(persistKey("create(persist((set) => ({ label: `)} ${1}` }), { name: 'kept' }))"), "kept");
});

test("persistKey finds persist's options past a block-bodied creator, a trailing comma and look-alike objects", () => {
  const store = [
    "export const useFlowStore = create<FlowState>()(",
    "  persist(",
    "    (set, get) => {",
    "      // a chart nobody's touched yet: the apostrophe must not open a string",
    "      const first = { name: 'My first money map', nodes: [], edges: [] }",
    "      const note = 'a paren ( inside a string'",
    "      return { charts: [first], rename: (name) => set({ name }) }",
    "    },",
    "    { name: 'fundsflow' },",
    "  ),",
    ")",
  ].join("\n");
  assert.equal(persistKey(store), "fundsflow");
  assert.equal(persistKey("export const s = create(persist((set) => ({ charts: [] }), { name: 'flow-app', version: 2 }))\n"), "flow-app");
  assert.equal(persistKey("export const s = create(persist((set) => ({}), options))\n"), undefined, "options held in a variable are not guessed at");
  assert.equal(persistKey("export const x = { name: 'not a store' }\n"), undefined);
});
