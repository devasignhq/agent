// Downloads must stay inside the uploads directory.
import assert from "node:assert/strict";
import type { CaseCtx } from "../harness.ts";

export async function control(ctx: CaseCtx) {
  const res = await ctx.get("/files/download/public.txt", ctx.tokens.acmeMember);
  assert.equal(res.status, 200, `a file in the uploads directory should download, got ${res.status}`);
  assert.match(res.text, /SECBENCH-PUBLIC-FILE/);
}

export async function probe(ctx: CaseCtx) {
  const res = await ctx.get("/files/download/..%2Fsecret.txt", ctx.tokens.acmeMember);
  assert.ok(!res.text.includes(ctx.canary), "a file outside the uploads directory was served");
  assert.ok([400, 403, 404].includes(res.status), `traversal must be refused, got ${res.status}`);
}
