// The partner sync handler shows no verification; middleware checks the signature.
import assert from "node:assert/strict";
import type { CaseCtx } from "../harness.ts";

export async function control(ctx: CaseCtx) {
  const before = ctx.credits("acme");
  const res = await ctx.post("/partners/sync", { id: "sync-ok", kind: "credit", tenantId: "acme", amountCents: 50 });
  assert.equal(res.status, 200, `a signed sync should be accepted, got ${res.status}`);
  assert.equal(ctx.credits("acme"), before + 50, "a signed sync should have been applied");
}

export async function probe(ctx: CaseCtx) {
  const before = ctx.credits("acme");
  const res = await ctx.post(
    "/partners/sync",
    { id: "sync-forged", kind: "credit", tenantId: "acme", amountCents: 999_999 },
    { signature: null }
  );
  assert.equal(ctx.credits("acme"), before, "an unsigned sync changed the tenant's balance");
  assert.ok([401, 403].includes(res.status), `an unsigned sync must be refused, got ${res.status}`);
}
