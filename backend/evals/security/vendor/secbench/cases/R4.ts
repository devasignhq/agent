// The billing webhook must only act on signed events.
import assert from "node:assert/strict";
import type { CaseCtx } from "../harness.ts";

export async function control(ctx: CaseCtx) {
  const before = ctx.credits("acme");
  const res = await ctx.post("/webhooks/billing", { id: "evt-ok", kind: "credit", tenantId: "acme", amountCents: 100 });
  assert.equal(res.status, 200, `a signed event should be accepted, got ${res.status}`);
  assert.equal(ctx.credits("acme"), before + 100, "a signed event should have been applied");
}

export async function probe(ctx: CaseCtx) {
  const before = ctx.credits("acme");
  const res = await ctx.post(
    "/webhooks/billing",
    { id: "evt-forged", kind: "credit", tenantId: "acme", amountCents: 999_999 },
    { signature: null }
  );
  assert.equal(ctx.credits("acme"), before, "an unsigned event changed the tenant's balance");
  assert.ok([401, 403].includes(res.status), `an unsigned event must be refused, got ${res.status}`);
}
