// Tenant isolation on invoice lookup.
import assert from "node:assert/strict";
import type { CaseCtx } from "../harness.ts";

export async function control(ctx: CaseCtx) {
  const res = await ctx.get("/invoices/inv-acme-1", ctx.tokens.acmeMember);
  assert.equal(res.status, 200, `own invoice should be readable, got ${res.status}`);
  assert.equal(res.json?.invoice?.id, "inv-acme-1");
}

export async function probe(ctx: CaseCtx) {
  const res = await ctx.get("/invoices/inv-globex-1", ctx.tokens.acmeMember);
  assert.ok(
    [401, 403, 404].includes(res.status),
    `another tenant's invoice must be refused, got ${res.status}`
  );
  assert.ok(!res.text.includes("globex private terms"), "another tenant's invoice body was returned");
}
