// Offline: the URLs a generated browser test is told it may open.
//   node --import tsx/esm --test src/verify/app-routes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appRoutes, isRouteModule, routeLines, routeWindow } from "./app-routes.js";

const empty = new Set<string>();
const src = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, content }));

const table = `export const ROUTE_PATHS = {
  agent: "/agent",
  workflow: "/workflow",
  root: "/",
  catchAll: "*",
} as const;
export const DEFAULT_ROUTE = ROUTE_PATHS.agent;
`;

test("a literal path, an identifier through a table in another file, and a redirect through a second constant", () => {
  const app = `<Routes>
  <Route path="/tests" element={<TestsPage />} />
  <Route path={ROUTE_PATHS.workflow} element={<WorkflowPage onHeader={x} />} />
  <Route path={ROUTE_PATHS.root} element={<Navigate to={DEFAULT_ROUTE} replace />} />
  <Route path={ROUTE_PATHS.catchAll} element={<Navigate to={DEFAULT_ROUTE} replace />} />
</Routes>`;
  assert.deepEqual(appRoutes(src({ "src/app.tsx": app, "src/routes.ts": table }), empty), [
    { path: "/tests", renders: "TestsPage" },
    { path: "/workflow", renders: "WorkflowPage" },
    { path: "/", redirectsTo: "/agent" },
  ]);
});

// The nine timeouts this module exists for: goto("/") lands on /agent, and the spec then waits
// on Workflow chrome that only /workflow renders.
test("the real app.tsx and routes.ts resolve to the URLs the app actually serves", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const routes = appRoutes(src({ "src/app.tsx": read("../../../frontend/src/app.tsx"), "src/routes.ts": read("../../../frontend/src/routes.ts") }), empty);
  assert.deepEqual(routes[0], { path: "/agent", renders: "AgentPage" });
  assert.deepEqual(routes.find((r) => r.path === "/"), { path: "/", redirectsTo: "/agent" });
  assert.deepEqual(routes.find((r) => r.path === "/workflow"), { path: "/workflow", renders: "WorkflowPage" });
  assert.deepEqual(routes.find((r) => r.path === "/bounties/:id/fund"), { path: "/bounties/:id/fund", renders: "FundBountyPage" });
  assert.deepEqual(routes.find((r) => r.path === "/settings"), { path: "/settings", redirectsTo: "/account" });
  assert.equal(routes.find((r) => r.path === "*" || r.path === "catchAll"), undefined);
});

test("route objects: element, Component, and a path through a constant; a webpack-shaped `path:` is not a route", () => {
  const router = `const router = createBrowserRouter([
  { path: "/x", element: <X /> },
  { path: "/y", Component: Y },
  { path: ROUTE_PATHS.workflow, element: <Navigate to="/x" replace /> },
]);
const build = { path: "/dist", minify: true };
`;
  assert.deepEqual(appRoutes(src({ "src/router.tsx": router, "src/routes.ts": table }), empty), [
    { path: "/x", renders: "X" },
    { path: "/y", renders: "Y" },
    { path: "/workflow", redirectsTo: "/x" },
  ]);
});

test("a route object is read whole: fields either side of `path`, and a data route naming no component", () => {
  const ordered = `const r = createBrowserRouter([{ element: <Root />, path: "/" }, { element: <Agent />, path: "/agent" }]);`;
  assert.deepEqual(appRoutes(src({ "src/router.tsx": ordered }), empty), [
    { path: "/", renders: "Root" },
    { path: "/agent", renders: "Agent" },
  ]);
  // react-router 6.4 data routes: `lazy` and `loader` say it is a route as plainly as an element,
  // and an app declaring only those was read as having no routes at all.
  const data = `export const router = createBrowserRouter([
  { path: "/", lazy: () => import("./pages/index") },
  { path: "/settings/billing", lazy: () => import("./pages/BillingSettings") },
  { path: "/orders", loader: ordersLoader, errorElement: <Err /> },
]);`;
  assert.deepEqual(appRoutes(src({ "src/router.tsx": data }), empty), [{ path: "/" }, { path: "/settings/billing" }, { path: "/orders" }]);
  assert.equal(isRouteModule("src/router.tsx", data), true);
  assert.deepEqual(appRoutes(src({ "src/vite.ts": `const build = { minify: true, path: "/dist" };` }), empty), [], "still not a route");
});

test("a parent route's children lend it neither their element nor their path", () => {
  const app = `<Route path="/parent" element={<Layout />}>
  <Route path="detail" element={<Detail />} />
  <Route index element={<Home />} />
</Route>`;
  assert.deepEqual(appRoutes(src({ "src/app.tsx": app }), empty), [{ path: "/parent", renders: "Layout" }]);
  const nested = `const routes = [{ path: "/parent", children: [{ path: "kid", element: <Kid /> }] }];`;
  assert.deepEqual(appRoutes(src({ "src/routes.tsx": nested }), empty), []);
});

test("nothing that is not a URL: `*`, the empty path, an unresolved name, and routes inside comments or strings", () => {
  const app = `// <Route path="/ghost" element={<Ghost />} />
/* { path: "/phantom", element: <Phantom /> } */
const help = "<Route path='/fake' element={<Fake />} />";
<Route path="*" element={<NotFound />} />
<Route path="" element={<Blank />} />
<Route path={MYSTERY} element={<Q />} />
<Route path={\`/\${slug}\`} element={<Slug />} />
<Route path="/real" element={<Real />} />`;
  assert.deepEqual(appRoutes(src({ "src/app.tsx": app }), empty), [{ path: "/real", renders: "Real" }]);
});

test("the same path declared twice is reported once, in declaration order", () => {
  const app = `<Route path="/b" element={<B />} />\n<Route path="/a" element={<A />} />\n<Route path="/b" element={<BAgain />} />`;
  assert.deepEqual(appRoutes(src({ "src/app.tsx": app }), empty), [
    { path: "/b", renders: "B" },
    { path: "/a", renders: "A" },
  ]);
});

test("file-system routing, only when the source declares no routes at all", () => {
  const appDir = new Set([
    "app/page.tsx", "app/tests/page.tsx", "app/(marketing)/about/page.tsx",
    "app/bounties/[id]/fund/page.tsx", "app/api/hook/route.ts", "app/layout.tsx",
  ]);
  assert.deepEqual(appRoutes([], appDir), [{ path: "/" }, { path: "/about" }, { path: "/bounties/:id/fund" }, { path: "/tests" }]);

  const pagesDir = new Set(["pages/index.tsx", "pages/about.tsx", "pages/[id].tsx", "pages/_app.tsx", "pages/_document.tsx", "pages/api/hello.ts"]);
  assert.deepEqual(appRoutes([], pagesDir), [{ path: "/" }, { path: "/:id" }, { path: "/about" }]);

  assert.deepEqual(appRoutes(src({ "src/app.tsx": `<Route path="/only" element={<Only />} />` }), appDir), [{ path: "/only" , renders: "Only" }]);
});

test("the list is capped so a 300-route app cannot crowd out the source", () => {
  const many = Array.from({ length: 300 }, (_, i) => `<Route path="/r${i}" element={<R${i} />} />`).join("\n");
  const routes = appRoutes(src({ "src/app.tsx": many }), empty);
  assert.equal(routes.length, 40);
  assert.deepEqual(routes[0], { path: "/r0", renders: "R0" });
});

test("routeLines reads as a prompt block, and says nothing when it found nothing", () => {
  const lines = routeLines(src({ "src/app.tsx": `<Route path={ROUTE_PATHS.workflow} element={<WorkflowPage />} />\n<Route path={ROUTE_PATHS.root} element={<Navigate to={DEFAULT_ROUTE} replace />} />`, "src/routes.ts": table }), empty);
  assert.equal(lines[0], "## URLs in this app");
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.slice(2), ["- /workflow — renders WorkflowPage", "- / — redirects to /agent"]);
  assert.deepEqual(routeLines(src({ "src/util.ts": "export const x = 1;\n" }), empty), []);
});

// The tree branch turns src/pages/BillingSettings.tsx into "/BillingSettings", which the app
// serves at /settings/billing; sold as the app's own table, an author types it verbatim.
test("a map guessed from the file tree says so, and one read from the source still says that", () => {
  const pages = new Set(["src/pages/index.tsx", "src/pages/Dashboard.tsx", "src/pages/BillingSettings.tsx"]);
  const guessed = routeLines(src({ "src/router.tsx": `export const routes = [{ path: "/dashboard", component: Dashboard }];` }), pages);
  assert.deepEqual(guessed.slice(2), ["- /", "- /BillingSettings", "- /Dashboard"]);
  assert.match(guessed[1], /^Guessed from the file tree/);
  assert.match(routeLines(src({ "src/app.tsx": `<Route path="/dashboard" element={<Dashboard />} />` }), pages)[1], /^Read off the app's own route table/);
});

// Anchored on the first route, a single `<Route>` in a guard component above the shell's table
// took the window and left the table — the one thing an author cannot guess — outside it.
test("routeWindow keeps the window holding the table, not the one holding the first route", () => {
  const table = `<Routes>
  <Route path="/agent" element={<AgentPage />} />
  <Route path="/tests" element={<TestsPage />} />
  <Route path="/workflow" element={<WorkflowPage />} />
  <Route path="/" element={<Navigate to="/agent" replace />} />
</Routes>`;
  const shell = `const AUTH = { path: "/login", Component: Login };\n${"// shell line\n".repeat(2_500)}${table}`;
  const window = routeWindow(shell, 12_000);
  assert.equal(window.length, 12_000);
  assert.deepEqual(appRoutes(src({ "src/app.tsx": window }), empty).map((r) => r.path), ["/agent", "/tests", "/workflow", "/"]);
});

test("routeWindow keeps the first route of a table too long to show whole", () => {
  const many = Array.from({ length: 400 }, (_, i) => `<Route path="/r${i}" element={<R${i} />} />`).join("\n");
  const routes = appRoutes(src({ "src/app.tsx": routeWindow(`${"// filler\n".repeat(2_400)}${many}`, 12_000) }), empty);
  assert.equal(routes[0].path, "/r0", "the snap to a line start goes backwards: forward skipped the route the window was cut for");
});

test("isRouteModule: a URL table matches, a constants file holding one path does not", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  assert.equal(isRouteModule("src/routes.ts", read("../../../frontend/src/routes.ts")), true);
  assert.equal(isRouteModule("src/app.tsx", read("../../../frontend/src/app.tsx")), true);
  assert.equal(isRouteModule("src/router.tsx", `export const routes = [{ path: "/x", element: <X /> }, { path: "/y", element: <Y /> }, { path: "/z", Component: Z }];`), true);
  assert.equal(isRouteModule("src/paths.ts", `export const HOME = "/";\nexport const ABOUT = "/about";\nexport const HELP = "/help";\n`), true);

  assert.equal(isRouteModule("src/config.ts", `export const API_BASE = "/api";\nexport const RETRIES = 3;\nexport const LABEL = "Save";\n`), false);
  assert.equal(isRouteModule("src/build.ts", `export const build = { path: "/dist", minify: true, target: "es2022" };\n`), false);
  assert.equal(isRouteModule("src/copy.ts", `// export const ROUTES = { a: "/a", b: "/b", c: "/c" };\n`), false);
  assert.equal(isRouteModule("src/routes.css", `.route { padding: 0 }\n`), false);
});
