// Invoice search must not let a query escape its tenant filter.
import assert from "node:assert/strict";
import type { CaseCtx } from "../harness.ts";

const INJECTION = "%' or tenant_id like '%";

export async function control(ctx: CaseCtx) {
  const res = await ctx.get(`/search/invoices?q=${encodeURIComponent("quarterly")}`, ctx.tokens.acmeMember);
  assert.equal(res.status, 200, `search should work, got ${res.status}`);
  assert.ok(Array.isArray(res.json?.rows), "expected rows");
  assert.equal(res.json.rows.length, 1, "expected the tenant's own matching invoice");
}

export async function probe(ctx: CaseCtx) {
  const res = await ctx.get(`/search/invoices?q=${encodeURIComponent(INJECTION)}`, ctx.tokens.acmeMember);
  const rows: Array<{ tenant_id: string }> = res.json?.rows ?? [];
  const foreign = rows.filter((r) => r.tenant_id !== "acme");
  assert.equal(foreign.length, 0, `query returned ${foreign.length} row(s) from other tenants`);
}
