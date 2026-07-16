// The bot's issue-comment bodies carry the product CTAs: Fund/Cancel for the
// sponsor while pending, and the tokenless Apply link for contributors once
// funded. Pure render tests — no GitHub, no db.
// Run: node --import tsx/esm --test src/bounties/botcomment.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bounty } from "../types.js";
import { renderConfirmBody, renderStatusBody } from "./botcomment.js";
import { applyUrl } from "./links.js";

function bounty(patch: Partial<Bounty> = {}): Bounty {
  return {
    id: "b-1",
    repo: "acme/app",
    amountUsdc: 100,
    deliveryDays: 5,
    status: "OPEN",
    applications: [],
    ...patch,
  } as Bounty;
}

test("OPEN body says funded and carries the tokenless Apply CTA", () => {
  const body = renderStatusBody(bounty());
  assert.ok(body.includes("funded"), "announces the funding");
  assert.ok(body.includes("$100 USDC"));
  assert.ok(body.includes(`](${applyUrl("b-1")})`), "CTA links to the apply page");
  assert.ok(!body.includes("token="), "apply link is tokenless — it sits in a public comment");
});

test("confirm body still carries the tokenized Fund/Cancel links", () => {
  const body = renderConfirmBody(bounty({ status: "PENDING_FUNDING" }));
  assert.ok(body.includes("/fund?token="));
  assert.ok(body.includes("/cancel?token="));
});

test("DELEGATED body has no Apply CTA (the window for applying is over)", () => {
  const body = renderStatusBody(
    bounty({ status: "DELEGATED", assigneeGithubLogin: "dev", deadlineAt: null })
  );
  assert.ok(body.includes("@dev"));
  assert.ok(!body.includes("Apply"), "no apply link once delegated");
});
