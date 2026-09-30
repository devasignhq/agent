// Admin routes are gated where they are mounted, not inside each handler.
import assert from "node:assert/strict";
import type { CaseCtx } from "../harness.ts";

export async function control(ctx: CaseCtx) {
  const res = await ctx.get("/admin/tenants", ctx.tokens.acmeAdmin);
  assert.equal(res.status, 200, `an admin should reach the admin route, got ${res.status}`);
  assert.ok(Array.isArray(res.json?.tenants), "expected the tenant list");
}

export async function probe(ctx: CaseCtx) {
  const res = await ctx.get("/admin/tenants", ctx.tokens.acmeMember);
  assert.ok([401, 403].includes(res.status), `a non-admin must be refused, got ${res.status}`);
  assert.ok(!res.text.includes("Globex Corporation"), "the tenant list leaked to a non-admin");
}
