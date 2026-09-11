// Offline: what a browser test's author is shown of the running app.
//   node --import tsx/esm --test src/verify/app-source.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { appSourceFor, entryPaths, localImports } from "./app-source.js";

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
  ]);
  assert.ok(out.every((f) => !f.truncated));
});

test("depth, file and size limits cut the crawl, truncating rather than dropping the file that crosses them", async () => {
  const shallow = await appSourceFor({ targetFiles: [], tree, read, limits: { files: 16, fileChars: 12_000, totalChars: 90_000, depth: 1 } });
  assert.deepEqual(shallow.map((f) => f.path), ["src/main.tsx", "src/App.tsx"]);
  const tight = await appSourceFor({ targetFiles: [], tree, read, limits: { files: 16, fileChars: 12_000, totalChars: 60, depth: 3 } });
  assert.deepEqual(tight.map((f) => [f.path, f.truncated]), [["src/main.tsx", false], ["src/App.tsx", true]]);
  assert.equal(tight.reduce((n, f) => n + f.content.length, 0), 60);
});
