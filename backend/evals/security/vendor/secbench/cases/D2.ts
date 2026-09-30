// The order handler takes an id from the URL; its repository is tenant-bound.
import assert from "node:assert/strict";
import type { CaseCtx } from "../harness.ts";

export async function control(ctx: CaseCtx) {
  const res = await ctx.get("/orders/ord-acme-1", ctx.tokens.acmeMember);
  assert.equal(res.status, 200, `own order should be readable, got ${res.status}`);
  assert.equal(res.json?.order?.id, "ord-acme-1");
}

export async function probe(ctx: CaseCtx) {
  const res = await ctx.get("/orders/ord-globex-1", ctx.tokens.acmeMember);
  assert.ok([401, 403, 404].includes(res.status), `another tenant's order must be refused, got ${res.status}`);
  assert.ok(!res.text.includes("SKU-9"), "another tenant's order was returned");
}
