// Drives the seeded run page in headless Chromium (autoplay allowed), proves the
// recording plays, and saves screenshots for the report.
import { chromium } from "@playwright/test";
const out = process.argv[2];
const cookie = process.argv[3];
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: "devasign_session", value: cookie, domain: "localhost", path: "/" }]);
const page = await ctx.newPage();
await page.goto("http://localhost:3001/reviews/ephemeral-review-verify?run=ephemeral-run-1&criterion=1");
await page.waitForSelector(".acv-rec.open video", { timeout: 20000 });
await page.waitForFunction(() => document.querySelector(".acv-rec.open video")?.readyState >= 3, null, { timeout: 20000 });
const played = await page.evaluate(async () => {
  const v = document.querySelector(".acv-rec.open video");
  await v.play();
  await new Promise((r) => setTimeout(r, 700));
  return { paused: v.paused, currentTime: v.currentTime, duration: v.duration, ended: v.ended };
});
console.log("playback:", JSON.stringify(played));
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/run-page.png`, fullPage: false });
const pane = await page.$(".goal-panel-body");
if (pane) await pane.screenshot({ path: `${out}/run-page-criteria.png` });
// Scroll the end-goal pane to show the expired + flaky rows and revisions.
await page.evaluate(() => { const p = document.querySelector(".goal-panel-body"); if (p) p.scrollTop = p.scrollHeight; });
await page.waitForTimeout(300);
if (pane) await pane.screenshot({ path: `${out}/run-page-criteria-bottom.png` });
await page.goto("http://localhost:3001/workflow");
await page.waitForSelector(".wf-rail .pr-card", { timeout: 20000 });
await page.waitForTimeout(1500);
const rail = await page.$(".wf-rail");
if (rail) await rail.screenshot({ path: `${out}/workflow-rail-flake.png` });
await browser.close();
console.log("done");
