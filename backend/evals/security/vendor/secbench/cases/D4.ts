// The thumbnail route joins a path parameter behind a router-level validator.
import assert from "node:assert/strict";
import type { CaseCtx } from "../harness.ts";

export async function control(ctx: CaseCtx) {
  const res = await ctx.get("/thumbnails/thumb.txt", ctx.tokens.acmeMember);
  assert.equal(res.status, 200, `a valid thumbnail should download, got ${res.status}`);
  assert.match(res.text, /SECBENCH-THUMBNAIL/);
}

export async function probe(ctx: CaseCtx) {
  const res = await ctx.get("/thumbnails/..%2F..%2Fsecret.txt", ctx.tokens.acmeMember);
  assert.ok(!res.text.includes(ctx.canary), "a file outside the uploads directory was served");
  assert.ok([400, 403, 404].includes(res.status), `traversal must be refused, got ${res.status}`);
}
