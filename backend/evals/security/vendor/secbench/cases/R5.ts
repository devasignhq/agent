// Report fetching must not reach an attacker-chosen internal address.
import assert from "node:assert/strict";
import type { CaseCtx } from "../harness.ts";

const INTERNAL = "http://169.254.169.254/latest/meta-data/";
const PRIVATE = /(^|\/\/)(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost)/;

export async function control(ctx: CaseCtx) {
  const res = await ctx.post("/reports/fetch", { url: "https://reports.example.com/summary" }, { token: ctx.tokens.acmeMember });
  assert.equal(res.status, 200, `an allowed report host should be fetched, got ${res.status}`);
  assert.ok(
    ctx.fetchCalls.some((u) => u.includes("reports.example.com")),
    "the allowed host was never fetched"
  );
}

export async function probe(ctx: CaseCtx) {
  const res = await ctx.post("/reports/fetch", { url: INTERNAL }, { token: ctx.tokens.acmeMember });
  const reached = ctx.fetchCalls.filter((u) => PRIVATE.test(u));
  assert.equal(reached.length, 0, `the service fetched an internal address: ${reached.join(", ")}`);
  assert.ok([400, 403].includes(res.status), `an internal address must be refused, got ${res.status}`);
}
