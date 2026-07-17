// Pure submission validation: PR-URL parse matrix, state/identity/repo
// preconditions, and supporting-link sanitization. Run:
//   node --import tsx/esm --test src/bounties/submission.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bounty } from "../types.js";
import { parsePrUrl, validateSubmission, sanitizeLinks, MAX_LINKS } from "./submission.js";

test("parsePrUrl accepts only canonical GitHub PR URLs", () => {
  assert.deepEqual(parsePrUrl("https://github.com/acme/pay/pull/318"), { repo: "acme/pay", prNumber: 318 });
  assert.deepEqual(parsePrUrl("  https://github.com/acme/pay/pull/318/  "), { repo: "acme/pay", prNumber: 318 });
  assert.deepEqual(parsePrUrl("https://github.com/a-b/c.d_e/pull/1"), { repo: "a-b/c.d_e", prNumber: 1 });

  for (const bad of [
    "http://github.com/acme/pay/pull/318",           // https only
    "https://github.com/acme/pay/pull/318?diff=split", // no query
    "https://github.com/acme/pay/issues/318",        // not a PR
    "https://github.com/acme/pay/pull/0x1",          // non-numeric
    "https://github.com/acme/pay/pull/0",            // positive only
    "https://evil.com/acme/pay/pull/318",            // github.com only
    "https://github.com/acme/pull/318",              // missing repo segment
    "github.com/acme/pay/pull/318",                  // scheme required
    42,
    null,
    undefined,
  ]) {
    assert.equal(parsePrUrl(bad as any), null, `should reject: ${String(bad)}`);
  }
});

const BASE = {
  status: "DELEGATED",
  assigneeGithubId: 100,
  repo: "acme/pay",
} as Bounty;

test("validateSubmission: status, assignee, and repo must all line up", () => {
  const parsed = { repo: "acme/pay", prNumber: 5 };
  assert.deepEqual(validateSubmission(BASE, { githubId: 100 }, parsed), { ok: true });
  // Re-submission while already in review is allowed.
  assert.deepEqual(validateSubmission({ ...BASE, status: "IN_REVIEW" } as Bounty, { githubId: 100 }, parsed), { ok: true });
  // Repo compare is case-insensitive (GitHub URLs are).
  assert.deepEqual(validateSubmission(BASE, { githubId: 100 }, { repo: "Acme/Pay", prNumber: 5 }), { ok: true });

  assert.deepEqual(validateSubmission({ ...BASE, status: "OPEN" } as Bounty, { githubId: 100 }, parsed), { ok: false, reason: "bad_status_open" });
  assert.deepEqual(validateSubmission({ ...BASE, status: "PAID" } as Bounty, { githubId: 100 }, parsed), { ok: false, reason: "bad_status_paid" });
  assert.deepEqual(validateSubmission(BASE, { githubId: 999 }, parsed), { ok: false, reason: "not_assignee" });
  assert.deepEqual(validateSubmission(BASE, { githubId: null }, parsed), { ok: false, reason: "not_assignee" });
  assert.deepEqual(validateSubmission(BASE, { githubId: 100 }, { repo: "acme/other", prNumber: 5 }), { ok: false, reason: "wrong_repo" });
});

test("sanitizeLinks: http(s) only, capped, labeled, invalid entries dropped", () => {
  const now = 1234;
  const links = sanitizeLinks(
    [
      { type: "Demo video", url: "https://loom.com/share/x" },
      { type: "", url: "http://acme.notion.site/doc" },
      { type: "Sneaky", url: "javascript:alert(1)" },
      { type: "Filey", url: "file:///etc/passwd" },
      { type: "NoUrl" },
      "not-an-object",
      { type: "Long", url: "https://x.com/" + "a".repeat(3000) },
      { type: "T".repeat(100), url: "https://ok.example/z" },
    ],
    now
  );
  assert.deepEqual(links, [
    { type: "Demo video", url: "https://loom.com/share/x", addedAt: now },
    { type: "Link", url: "http://acme.notion.site/doc", addedAt: now },
    { type: "T".repeat(40), url: "https://ok.example/z", addedAt: now },
  ]);
  // Count cap.
  const many = sanitizeLinks(Array.from({ length: 20 }, (_, i) => ({ type: "L", url: `https://x.example/${i}` })), now);
  assert.equal(many.length, MAX_LINKS);
  // Non-arrays normalize to empty.
  assert.deepEqual(sanitizeLinks("nope", now), []);
  assert.deepEqual(sanitizeLinks(undefined, now), []);
});
