// Unit tests for the Freighter funding handshake (bounty-fund.ts).
//
// The load-bearing one is the `not_durable` 503 after submit: the transaction is
// already broadcast at that point, so treating it as an error would tell a
// sponsor their funding failed while their USDC moves into escrow. That branch
// shipped untested inside a React component; extracting it is what finally lets
// it be pinned.
//   node --test src/bounty-fund.test.ts
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFund, type FundDeps, type FundPhase } from "./bounty-fund.ts";

function harness(overrides: Partial<FundDeps> = {}) {
  const phases: FundPhase[] = [];
  const msgs: (string | null)[] = [];
  const hashes: (string | null)[] = [];
  const deps: FundDeps = {
    getAddress: async () => "GSPONSOR",
    buildTx: async () => ({ xdr: "AAAA", networkPassphrase: "Test SDF Network ; September 2015" }),
    sign: async (xdr) => `signed:${xdr}`,
    submit: async () => ({ hash: "abc123" }),
    setPhase: (p) => phases.push(p),
    setMsg: (m) => msgs.push(m),
    setHash: (h) => hashes.push(h),
    ...overrides,
  };
  return { deps, phases, msgs, hashes };
}

function apiError(status: number, message: string, body?: unknown) {
  return Object.assign(new Error(message), { status, body });
}

test("happy path: working → done, records the tx hash", async () => {
  const h = harness();
  await runFund(h.deps);

  assert.deepEqual(h.phases, ["working", "done"]);
  assert.deepEqual(h.hashes, ["abc123"]);
  assert.deepEqual(h.msgs, [null], "clears any prior error before starting");
});

test("signs the XDR the backend built, against the passphrase it was built for", async () => {
  const seen: string[] = [];
  const h = harness({
    buildTx: async () => ({ xdr: "XDR-1", networkPassphrase: "Public Global Stellar Network ; September 2015" }),
    sign: async (xdr, address, passphrase) => {
      seen.push(xdr, address, passphrase);
      return "signed";
    },
  });
  await runFund(h.deps);

  assert.deepEqual(seen, ["XDR-1", "GSPONSOR", "Public Global Stellar Network ; September 2015"]);
});

test("submits the SIGNED envelope, not the unsigned one", async () => {
  let submitted = "";
  const h = harness({ submit: async (signed) => ((submitted = signed), { hash: "h" }) });
  await runFund(h.deps);

  assert.equal(submitted, "signed:AAAA");
});

// ── the branch that matters ──────────────────────────────────────────────────

test("a not_durable 503 AFTER submit becomes 'confirming', never 'error'", async () => {
  const h = harness({
    submit: async () => {
      throw apiError(503, "not_durable", { error: "not_durable" });
    },
  });
  await runFund(h.deps);

  assert.deepEqual(
    h.phases,
    ["working", "confirming"],
    "the tx is already broadcast — reporting failure would be a lie about the sponsor's money"
  );
  assert.deepEqual(h.msgs, [null], "no error message shown");
});

test("not_durable is recognized from either the message or the body", async () => {
  for (const err of [
    apiError(503, "not_durable"),
    apiError(503, "something else", { error: "not_durable" }),
  ]) {
    const h = harness({ submit: async () => { throw err; } });
    await runFund(h.deps);
    assert.equal(h.phases.at(-1), "confirming");
  }
});

test("a non-transient submit failure IS an error", async () => {
  const h = harness({
    submit: async () => {
      throw apiError(409, "already_open");
    },
  });
  await runFund(h.deps);

  assert.deepEqual(h.phases, ["working", "error"]);
  assert.equal(h.msgs.at(-1), "already_open");
});

test("a 503 that is NOT not_durable is still an error", async () => {
  const h = harness({
    submit: async () => {
      throw apiError(503, "stellar_unconfigured", { error: "stellar_unconfigured" });
    },
  });
  await runFund(h.deps);

  assert.equal(h.phases.at(-1), "error");
});

// ── failures before broadcast ────────────────────────────────────────────────

test("a missing wallet errors before anything is built", async () => {
  let built = false;
  const h = harness({
    getAddress: async () => {
      throw new Error("Freighter wallet not detected.");
    },
    buildTx: async () => ((built = true), { xdr: "x", networkPassphrase: "p" }),
  });
  await runFund(h.deps);

  assert.deepEqual(h.phases, ["working", "error"]);
  assert.equal(h.msgs.at(-1), "Freighter wallet not detected.");
  assert.equal(built, false);
});

test("a cancelled signature errors without submitting", async () => {
  let submitted = false;
  const h = harness({
    sign: async () => {
      throw new Error("User declined access");
    },
    submit: async () => ((submitted = true), { hash: "h" }),
  });
  await runFund(h.deps);

  assert.equal(h.phases.at(-1), "error");
  assert.equal(submitted, false, "nothing may be broadcast if the sponsor declined");
});

test("a build failure surfaces the backend's reason", async () => {
  const h = harness({
    buildTx: async () => {
      throw apiError(409, "already_open");
    },
  });
  await runFund(h.deps);

  assert.equal(h.phases.at(-1), "error");
  assert.equal(h.msgs.at(-1), "already_open");
});

test("an error with no message still shows something actionable", async () => {
  const h = harness({ getAddress: async () => { throw new Error(""); } });
  await runFund(h.deps);

  assert.equal(h.msgs.at(-1), "Funding failed.");
});
