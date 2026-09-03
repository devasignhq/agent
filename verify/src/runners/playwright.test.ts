// node --import tsx/esm --test src/runners/playwright.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePlaywrightConfig, mapReport, ourPlaywrightDir, webServerFromYml, type PwReport } from "./playwright.js";
import { Workspace } from "../workspace.js";
import type { LocalArtifact, PlanTest } from "../types.js";

test("the generated config extends the customer's and forces recording even when theirs sets video: 'off'", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-pw-"));
  writeFileSync(path.join(root, "playwright.config.ts"), `export default { use: { video: "off", trace: "off", baseURL: "http://x" }, retries: 0, projects: [{ name: "firefox" }, { name: "chromium" }], webServer: { command: "npm start", url: "http://x" } };\n`);
  const src = generatePlaywrightConfig({ root, baseConfigRel: "playwright.config.ts", testDir: path.join(root, ".devasign/tests/e2e"), outputDir: path.join(root, ".devasign/artifacts/pw"), reportFile: path.join(root, "r.json"), retries: 2, webServer: { command: "node s.mjs", url: "http://localhost:4173/healthz", baseUrl: "http://localhost:4173" } });
  assert.match(src, /import __base from ".*playwright\.config\.ts"/);
  assert.match(src, /video: "on", trace: "on", screenshot: "on"/);
  assert.match(src, /retries: 2/);
  assert.match(src, /webServer: b\.webServer \?\? \{ command: "node s\.mjs"/, "their webServer wins when present");
  assert.match(src, /cwd: ".*"/);
  // Evaluate the generated config the way Playwright would (tsx transform).
  const ws = new Workspace(root);
  ws.linkPackage("@playwright/test", ourPlaywrightDir()); // the CLI does this for repos without Playwright
  const cfgPath = ws.write(".devasign/playwright.config.ts", src);
  const mod = await import(cfgPath);
  const cfg = mod.default;
  assert.equal(cfg.use.video, "on");
  assert.equal(cfg.use.trace, "on");
  assert.equal(cfg.use.baseURL, "http://x", "their baseURL is kept");
  assert.deepEqual(cfg.projects.map((p: any) => p.name), ["chromium"], "one chromium project only");
  assert.equal(cfg.webServer.command, "npm start");
  const noBase = generatePlaywrightConfig({ root, baseConfigRel: null, testDir: root, outputDir: root, reportFile: "r", retries: 0, webServer: null });
  assert.match(noBase, /const __base: any = \{\};/);
  assert.doesNotMatch(noBase, /webServer/);
});

test("webServerFromYml chains install/build/seed/start and uses the ready path", () => {
  assert.equal(webServerFromYml(null), null);
  assert.deepEqual(webServerFromYml({ start: "node s.mjs", url: "http://localhost:4173", ready: "/healthz", install: "npm ci" }), { command: "npm ci && node s.mjs", url: "http://localhost:4173/healthz", baseUrl: "http://localhost:4173" });
});

test("mapReport: attempts from per-retry results, attachments become artifacts, poster pairs with its own attempt's video", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-map-"));
  const ws = new Workspace(root);
  const dir = path.join(root, ".devasign/artifacts/pw/x");
  mkdirSync(dir, { recursive: true });
  const files = ["shot1.png", "vid1.webm", "trace1.zip", "shot2.png", "vid2.webm"].map((f) => { const p = path.join(dir, f); writeFileSync(p, "x"); return p; });
  const report: PwReport = {
    suites: [{ title: "criterion-3.spec.ts", file: "criterion-3.spec.ts", specs: [{ title: "discounts", file: "criterion-3.spec.ts", tests: [{ status: "unexpected", results: [
      { status: "failed", retry: 0, duration: 1200, error: { message: "Error: expect(locator).toBeVisible() failed\n[2mExpected: visible" }, attachments: [{ name: "screenshot", contentType: "image/png", path: files[0] }, { name: "video", contentType: "video/webm", path: files[1] }, { name: "trace", contentType: "application/zip", path: files[2] }] },
      { status: "failed", retry: 1, duration: 900, error: { message: "Error: expect(locator).toBeVisible() failed" }, attachments: [{ name: "screenshot", contentType: "image/png", path: files[3] }, { name: "video", contentType: "video/webm", path: files[4] }] },
    ] }] }] }],
  };
  const t: PlanTest = { id: "t3", path: ".devasign/tests/e2e/criterion-3.spec.ts", content: "", criterionIds: ["3"], level: "e2e", levelReason: "", origin: "generated", runner: "playwright", testSignature: "s", strategyVersion: 1, targetFiles: [] };
  const artifacts: LocalArtifact[] = [];
  const [res] = mapReport(report, [t], ws, artifacts, "");
  assert.equal(res.status, "fail");
  assert.equal(res.attempts.length, 2);
  assert.deepEqual(res.attempts.map((a) => a.status), ["fail", "fail"]);
  assert.doesNotMatch(res.attempts[0].error!, //);
  const posters = artifacts.filter((a) => a.kind === "poster");
  assert.equal(posters.length, 2);
  assert.equal(posters[0].posterFor, "video:t3:1:1");
  assert.equal(posters[0].path, files[0], "attempt 1's poster is attempt 1's screenshot");
  assert.equal(posters[1].posterFor, "video:t3:2:1");
  assert.equal(artifacts.filter((a) => a.kind === "video").length, 2);
  assert.ok(res.attempts[0].artifactIds.includes("poster:t3:1"));
  // A planned file with no result in the report is an error, not a fail.
  const [missing] = mapReport({ suites: [] }, [{ ...t, id: "t9", path: "x.spec.ts" }], ws, [], "Error: Process from config.webServer was not able to start");
  assert.equal(missing.status, "error");
  assert.match(missing.error!, /webServer/);
});
