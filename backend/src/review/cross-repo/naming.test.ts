// Pure string helpers, no db and no network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/cross-repo/naming.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  familyRoot,
  familyStem,
  languageAffixOf,
  ownerOf,
  repoNameOf,
  roleOf,
  routeLiterals,
  splitWords,
  stripFamilyAffixes,
  symbolVariants,
} from "./naming.js";

test("repoNameOf / ownerOf split owner/repo", () => {
  assert.equal(repoNameOf("acme/acme-sdk-go"), "acme-sdk-go");
  assert.equal(ownerOf("acme/acme-sdk-go"), "acme");
  assert.equal(repoNameOf("bare"), "bare");
  assert.equal(ownerOf("bare"), "");
});

test("splitWords handles camel, Pascal, snake, kebab and acronyms", () => {
  assert.deepEqual(splitWords("createBounty"), ["create", "bounty"]);
  assert.deepEqual(splitWords("CreateBounty"), ["create", "bounty"]);
  assert.deepEqual(splitWords("create_bounty"), ["create", "bounty"]);
  assert.deepEqual(splitWords("create-bounty"), ["create", "bounty"]);
  assert.deepEqual(splitWords("CREATE_BOUNTY"), ["create", "bounty"]);
  assert.deepEqual(splitWords("parseURL"), ["parse", "url"]);
  assert.deepEqual(splitWords("HTTPServer"), ["http", "server"]);
});

test("symbolVariants covers every convention a sibling might use", () => {
  const v = symbolVariants("createBounty");
  for (const want of ["createBounty", "CreateBounty", "create_bounty", "create-bounty", "CREATE_BOUNTY"]) {
    assert.ok(v.includes(want), `missing ${want} in ${v.join(",")}`);
  }
});

test("symbolVariants is stable whichever spelling comes in", () => {
  const fromSnake = new Set(symbolVariants("create_bounty"));
  for (const want of ["createBounty", "CreateBounty", "create_bounty", "CREATE_BOUNTY"]) {
    assert.ok(fromSnake.has(want), `missing ${want}`);
  }
});

test("symbolVariants keeps the original acronym spelling first", () => {
  assert.equal(symbolVariants("parseURL")[0], "parseURL");
});

test("symbolVariants ignores empty and punctuation-only input", () => {
  assert.deepEqual(symbolVariants(""), []);
  assert.deepEqual(symbolVariants("   "), []);
  assert.deepEqual(symbolVariants("__"), []);
});

test("routeLiterals strips the method and stops at the first param", () => {
  assert.deepEqual(routeLiterals("POST /v1/payouts"), ["/v1/payouts", "v1/payouts"]);
  const withParam = routeLiterals("GET /api/bounties/:id");
  assert.ok(withParam.includes("/api/bounties"));
  assert.ok(withParam.includes("/api/bounties/:id"));
});

test("routeLiterals handles brace and angle param syntax", () => {
  assert.ok(routeLiterals("/api/bounties/{id}/claim").includes("/api/bounties"));
  assert.ok(routeLiterals("/api/bounties/<id>").includes("/api/bounties"));
});

test("routeLiterals rejects non-routes", () => {
  assert.deepEqual(routeLiterals("createBounty"), []);
  assert.deepEqual(routeLiterals(""), []);
  assert.deepEqual(routeLiterals("/"), []);
});

test("stripFamilyAffixes removes language affixes but keeps the role", () => {
  assert.equal(stripFamilyAffixes("acme-sdk-ts"), "acme-sdk");
  assert.equal(stripFamilyAffixes("acme-sdk-go"), "acme-sdk");
  assert.equal(stripFamilyAffixes("acme-sdk-python"), "acme-sdk");
  assert.equal(stripFamilyAffixes("acme.js"), "acme");
});

test("stripFamilyAffixes with roles reaches the bare root", () => {
  assert.equal(stripFamilyAffixes("acme-sdk-ts", { roles: true }), "acme");
  assert.equal(stripFamilyAffixes("acme-client-py", { roles: true }), "acme");
});

test("stripFamilyAffixes never strips the whole name away", () => {
  assert.equal(stripFamilyAffixes("sdk"), "sdk");
  assert.equal(stripFamilyAffixes("go", { roles: true }), "go");
});

test("familyStem clusters an SDK family and keeps unrelated repos apart", () => {
  const members = ["acme/acme-sdk-ts", "acme/acme-sdk-go", "acme/acme-sdk-python"];
  const stems = new Set(members.map(familyStem));
  assert.equal(stems.size, 1);
  assert.equal([...stems][0], "acme-sdk");
  assert.notEqual(familyStem("acme/acme-web"), "acme-sdk");
});

test("familyRoot clusters across differing roles", () => {
  assert.equal(familyRoot("acme/acme-sdk-go"), "acme");
  assert.equal(familyRoot("acme/acme-client-py"), "acme");
  assert.equal(familyRoot("acme/acme-web"), "acme");
});

test("roleOf reads the role affix past the language affix", () => {
  assert.equal(roleOf("acme/acme-sdk-ts"), "sdk");
  assert.equal(roleOf("acme/acme-web"), "web");
  assert.equal(roleOf("devasignhq/soroban-escrow"), null);
  assert.equal(roleOf("acme/acme-contracts"), "contract");
});

test("languageAffixOf reads the language affix", () => {
  assert.equal(languageAffixOf("acme/acme-sdk-ts"), "ts");
  assert.equal(languageAffixOf("acme/acme-sdk-python"), "python");
  assert.equal(languageAffixOf("acme/acme-sdk"), null);
});
