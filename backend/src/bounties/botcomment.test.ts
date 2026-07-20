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

// ── the locked acceptance list on the funded comment ─────────────────────────
// A contributor should be able to read the contract they'd be paid against
// before deciding to apply, not after signing in.

test("OPEN body lists the locked acceptance criteria", () => {
  const body = renderStatusBody(
    bounty({ acceptance: ["Duplicate deliveries are ignored", "A replay returns 202"] })
  );
  assert.match(body, /Acceptance criteria/);
  assert.match(body, /reviewed against exactly this list/);
  assert.ok(body.includes("- Duplicate deliveries are ignored"));
  assert.ok(body.includes("- A replay returns 202"));
});

test("OPEN body is unchanged when there are no criteria", () => {
  const withNone = renderStatusBody(bounty({ acceptance: [] }));
  const legacy = renderStatusBody(bounty()); // no acceptance field at all
  assert.ok(!withNone.includes("Acceptance criteria"), "no empty header on a bounty with no list");
  assert.equal(legacy, withNone, "a legacy row renders exactly like an empty one");
});

test("a long list is capped with a pointer to the app rather than flooding the issue", () => {
  const many = Array.from({ length: 12 }, (_, i) => `Criterion number ${i + 1}`);
  const body = renderStatusBody(bounty({ acceptance: many }));
  assert.ok(body.includes("- Criterion number 8"));
  assert.ok(!body.includes("- Criterion number 9"), "capped at 8");
  assert.match(body, /and 4 more/);
});

test("criteria appear only once funded, never on the pending confirm comment", () => {
  const pending = renderStatusBody(
    bounty({ status: "PENDING_FUNDING", acceptance: ["Not locked yet"] })
  );
  assert.ok(
    !pending.includes("Acceptance criteria"),
    "before funding the list can still change — publishing it would go stale on the next edit"
  );
});
