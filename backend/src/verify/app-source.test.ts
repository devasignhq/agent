// Offline: what a browser test's author is shown of the running app.
//   node --import tsx/esm --test src/verify/app-source.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { appSourceFor, entryPaths, localImports, persistKey, sourceUnderTest, waysIn } from "./app-source.js";
import { appRoutes } from "./app-routes.js";

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

test("the author sees the test's targets first, then the entry and the screens between it and them, and never a test file", async () => {
  const out = await appSourceFor({ targetFiles: ["src/components/Pill.tsx", "src/components/Canvas.test.tsx"], tree, read });
  // App and Canvas are the path from the entry down to Pill; Palette and the two below Pill are
  // not, so they rank behind the store the flow's own screens read.
  assert.deepEqual(out.map((f) => f.path), [
    "src/components/Pill.tsx",
    "src/main.tsx",
    "src/App.tsx",
    "src/components/Canvas.tsx",
    "src/store/index.ts",
    "src/components/Deep.tsx",
    "src/components/Deeper.tsx",
    "src/components/Palette.tsx",
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

// Measured against this repo's own frontend: nine screens spent all 140K characters, the crawl
// stopped before routes.ts, and the spec went to "/" — which redirects to /agent, not /workflow.
const screen = (name: string) => `export function ${name}() {}\n// ${"x".repeat(13_000)}\n`;
const routed: Record<string, string> = {
  "index.html": '<script type="module" src="/src/main.tsx"></script>\n',
  "src/main.tsx": "import App from './app'\n",
  "src/app.tsx": [
    "import { ROUTE_PATHS, DEFAULT_ROUTE } from './routes'",
    "import { WorkflowPage } from './screen-workflow'",
    "import { AgentPage } from './screen-agent'",
    "import { BountiesPage } from './screen-bounties'",
    "import { TestsPage } from './screen-tests'",
    "import { FundPage } from './screen-fund-bounty'",
    "  <Route path={ROUTE_PATHS.workflow} element={<WorkflowPage />} />",
    "  <Route path={ROUTE_PATHS.agent} element={<AgentPage />} />",
    "  <Route path={ROUTE_PATHS.bounty} element={<BountiesPage />} />",
    "  <Route path={ROUTE_PATHS.tests} element={<TestsPage />} />",
    "  <Route path={ROUTE_PATHS.root} element={<Navigate to={DEFAULT_ROUTE} replace />} />",
  ].join("\n"),
  "src/routes.ts": "export const ROUTE_PATHS = { agent: '/agent', workflow: '/workflow', tests: '/tests', bounty: '/bounty', root: '/' } as const\nexport const DEFAULT_ROUTE = ROUTE_PATHS.agent\n",
  "src/screen-workflow.tsx": `import { SEED_REPO } from './seed'\nexport function WorkflowPage() {}\n// ${"w".repeat(3_000)}\n`,
  "src/seed.ts": "export const SEED_REPO = 'ephemeral-tester/demo'\n",
  "src/screen-agent.tsx": screen("AgentPage"),
  "src/screen-bounties.tsx": screen("BountiesPage"),
  "src/screen-tests.tsx": screen("TestsPage"),
  "src/screen-fund-bounty.tsx": screen("FundPage"),
};
const routedTree = new Set(Object.keys(routed));
const routedRead = async (p: string) => routed[p] ?? null;
const unopened = ["src/screen-agent.tsx", "src/screen-bounties.tsx", "src/screen-tests.tsx", "src/screen-fund-bounty.tsx"];

test("the module holding the app's URLs outranks the screens the flow never opens", async () => {
  const decisive = ["src/screen-workflow.tsx", "src/routes.ts", "src/app.tsx", "src/main.tsx", "src/seed.ts"];
  const totalChars = decisive.reduce((n, f) => n + routed[f].length, 0);
  const out = await appSourceFor({ targetFiles: ["src/screen-workflow.tsx"], tree: routedTree, read: routedRead, limits: { files: 60, fileChars: 12_000, totalChars, depth: 8 } });
  assert.equal(out[0].path, "src/screen-workflow.tsx", "the target first");
  assert.deepEqual(out.map((f) => f.path).slice(1).sort(), decisive.slice(1).sort(), "then the URL table and the way to the target — the four screens it never opens no longer fit");
  assert.ok(out.every((f) => !f.truncated));
  assert.match(out.find((f) => f.path === "src/routes.ts")!.content, /workflow: '\/workflow'/, "the URL literal itself: app.tsx names only ROUTE_PATHS.workflow");
  assert.equal(out.reduce((n, f) => n + f.content.length, 0), totalChars, "and the budget is still spent to the full");
  const roomy = await appSourceFor({ targetFiles: ["src/screen-workflow.tsx"], tree: routedTree, read: routedRead });
  assert.deepEqual(roomy.map((f) => f.path).slice(5), unopened, "with room to spare they come last, not first");
});

test("a shell too long to show whole still shows the route table at its foot", async () => {
  // The measured failure: app.tsx was 45K with its <Route> table at 39K, so head-first truncation
  // cut every route and the prompt's URL map came out empty on the app it was written for.
  const bloated: Record<string, string> = { ...routed, "src/app.tsx": `${"// shell\n".repeat(1_200)}${routed["src/app.tsx"]}` };
  const tree = new Set(Object.keys(bloated));
  const read = async (p: string) => bloated[p] ?? null;
  const out = await appSourceFor({ targetFiles: ["src/screen-workflow.tsx"], tree, read, limits: { files: 60, fileChars: 4_000, totalChars: 90_000, depth: 8 } });
  const shell = out.find((f) => f.path === "src/app.tsx")!;
  assert.ok(shell.content.length <= 4_000, "still inside its per-file budget");
  assert.ok(shell.truncated, "and still announced as partial — the author must not read it as the whole shell");
  const urls = appRoutes(out, tree);
  assert.deepEqual(urls.map((r) => r.path).sort(), ["/", "/agent", "/bounty", "/tests", "/workflow"], "every URL survives the cut");
  assert.deepEqual(urls.find((r) => r.path === "/"), { path: "/", redirectsTo: "/agent" }, "including the redirect that left specs waiting on the wrong screen");
});

test("a route table at the foot survives on the last of the shared budget, not just the per-file one", async () => {
  // The window was sized against fileChars and then head-sliced by `add` to the smaller room the
  // shared budget had left — which is the head-first cut the window exists to avoid.
  const shell = `${"// shell\n".repeat(1_200)}<Routes>
  <Route path="/workflow" element={<WorkflowPage />} />
  <Route path="/agent" element={<AgentPage />} />
  <Route path="/" element={<Navigate to="/agent" replace />} />
</Routes>
`;
  const f: Record<string, string> = {
    "index.html": '<script type="module" src="/src/main.tsx"></script>\n',
    "src/main.tsx": "import App from './app'\n",
    "src/app.tsx": shell,
    "src/screen-workflow.tsx": `export function WorkflowPage() {}\n// ${"w".repeat(9_000)}\n`,
  };
  const t = new Set(Object.keys(f));
  const limits = { files: 60, fileChars: 12_000, totalChars: 11_600, depth: 8 };
  const out = await appSourceFor({ targetFiles: ["src/screen-workflow.tsx"], tree: t, read: async (p) => f[p] ?? null, limits });
  const emitted = out.find((x) => x.path === "src/app.tsx")!;
  assert.ok(emitted.content.length < limits.fileChars, "the target ahead of it left under a per-file budget to spend");
  assert.ok(emitted.truncated, "and it is still announced as partial");
  assert.deepEqual(appRoutes(out, t).map((r) => r.path), ["/workflow", "/agent", "/"], "every URL survives the squeeze");
});

test("the labels the shell imports keep their rank when the shell is the file holding the routes", async () => {
  // The shell is normally the <Route> table too, and ranking it as one took it out of the seed
  // for the plain modules, dropping its labels past every screen to the foot of the list.
  const f: Record<string, string> = {
    "index.html": '<script type="module" src="/src/main.tsx"></script>\n',
    "src/main.tsx": "import App from './app'\n",
    "src/app.tsx": "import { WorkflowPage } from './screen-workflow'\nimport { LABELS } from './labels'\n  <Route path=\"/workflow\" element={<WorkflowPage />} />\n  <Route path=\"/agent\" element={<AgentPage />} />\n  <Route path=\"/\" element={<Navigate to=\"/agent\" replace />} />\n",
    "src/screen-workflow.tsx": "import { WorkflowChild } from './workflow-child'\nexport function WorkflowPage() {}\n",
    "src/workflow-child.tsx": "export function WorkflowChild() {}\n",
    "src/labels.ts": "export const LABELS = { save: 'Save graph' }\n",
  };
  const out = await appSourceFor({ targetFiles: ["src/screen-workflow.tsx"], tree: new Set(Object.keys(f)), read: async (p) => f[p] ?? null });
  assert.deepEqual(out.map((x) => x.path), ["src/screen-workflow.tsx", "src/app.tsx", "src/main.tsx", "src/labels.ts", "src/workflow-child.tsx"]);
});

test("a PR that changed a dozen large screens cannot starve the URL table", async () => {
  // Measured on this repo's own frontend: twelve changed files of 12K spent the whole budget
  // between them, routes.ts fell off the end and the URL map went from 21 lines to none.
  const targets = ["src/screen-workflow.tsx", ...unopened];
  const spent = targets.reduce((n, f) => n + Math.min(routed[f].length, 12_000), 0);
  const out = await appSourceFor({ targetFiles: targets, tree: routedTree, read: routedRead, limits: { files: 60, fileChars: 12_000, totalChars: spent, depth: 8 } });
  assert.deepEqual(out.slice(0, targets.length).map((f) => f.path), targets, "the targets still come first");
  assert.deepEqual(appRoutes(out, routedTree).map((r) => r.path), ["/workflow", "/agent", "/bounty", "/tests", "/"], "and the URL map survives a budget the targets alone would spend");
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
  assert.equal(persistKey("create(persist((set) => ({ label: `a ${x ? `(` : ''} b` }), { name: 'kept' }))"), "kept", "a template inside another's ${}");
  // From review: `*` and `%` do belong in the set — after either, a `/` can only open a regex.
  assert.equal(persistKey("create(persist((set) => ({ n: 2 * /[)]/.source.length }), { name: 'kept' }))"), "kept");
  assert.equal(persistKey("create(persist((set) => ({ a: (n) => n * 2 / 4, b: (n) => n % 4 / 2 }), { name: 'kept' }))"), "kept", "a division after either is still a division");
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
