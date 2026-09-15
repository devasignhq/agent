// Unit tests for the verification layer's pure parts: the mechanical evidence
// check, the evidence bundle, verdict coercion, citation enforcement and the
// severity/confidence rewrite. No db / network / LLM. Run:
//   node --import tsx/esm --test src/security/verify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyVerdict,
  buildEvidenceBundle,
  coerceVerdicts,
  describeVerdict,
  enforceCitations,
  mechanicalCheck,
  normalizeQuote,
  quoteInFile,
  selectBundleEntries,
  BUNDLE_MAX_FILES,
  type RawVerdict,
} from "./verify.js";
import type { AgentFinding } from "./agent.js";
import type { RepoIndexEntry } from "../types.js";

const CONTENT = `export function payoutHandler(req, res) {\n  const accountId = req.body.accountId;\n  return transfer(accountId, req.body.amount);\n}\n`;

const finding = (over: Partial<AgentFinding> = {}): AgentFinding => ({
  slug: "payout-route-missing-auth",
  class: "missing-authz",
  surface: "api",
  severity: "medium",
  claimedSeverity: "high",
  confidence: "needs_human",
  title: "payout route lacks an authorization check",
  concern: "reads the account id from the body",
  evidence: "line 42: `const accountId = req.body.accountId;`",
  symbol: "payoutHandler",
  line: 42,
  exploitNarrative: ["a", "b", "c"],
  ...over,
});

const entry = (path: string, over: Partial<RepoIndexEntry> = {}): RepoIndexEntry => ({
  id: path,
  repoId: "r1",
  path,
  sha: `sha-${path}`,
  size: 10,
  language: "ts",
  summary: "",
  exports: [],
  imports: [],
  securityFlags: [],
  indexedAt: 0,
  model: "m",
  ...over,
});

test("normalizeQuote strips line markers, backticks and fences", () => {
  assert.deepEqual(normalizeQuote("line 42: `const a = 1;`"), ["const a = 1;"]);
  assert.deepEqual(normalizeQuote("```ts\nL7:   foo(  bar );\n...\n```"), ["foo( bar );"]);
});

test("quoteInFile finds every quoted line and reports the first one's line", () => {
  assert.equal(quoteInFile("const accountId = req.body.accountId;", CONTENT), 2);
  assert.equal(quoteInFile("2: const accountId = req.body.accountId;\n3: return transfer(accountId, req.body.amount);", CONTENT), 2);
  assert.equal(quoteInFile("const accountId = req.body.tenantId;", CONTENT), null);
  // A quote made only of trivia can't anchor anything.
  assert.equal(quoteInFile("}", CONTENT), null);
});

test("mechanicalCheck keeps a finding whose evidence is in the file and repairs a bad line", () => {
  const r = mechanicalCheck(finding(), CONTENT);
  assert.ok(r.ok);
  assert.equal(r.finding.line, 2);
  const near = mechanicalCheck(finding({ line: 4 }), CONTENT);
  assert.ok(near.ok && near.finding.line === 4);
});

test("mechanicalCheck drops findings with no evidence, unmatched evidence or an absent symbol", () => {
  for (const over of [
    { evidence: undefined },
    { evidence: "line 9: db.query(`SELECT * FROM x WHERE id = ${id}`)" },
    { symbol: "refundHandler" },
  ]) {
    const r = mechanicalCheck(finding(over), CONTENT);
    assert.ok(!r.ok && r.reason === "evidence_not_in_file", JSON.stringify(over));
  }
});

test("selectBundleEntries orders imports, dependents, then nearby control files, and skips self and tests", () => {
  const target = entry("api/routes/payouts.ts", { imports: ["./ledger", "express"] });
  const all = [
    target,
    entry("api/routes/ledger.ts"),
    entry("api/app.ts", { imports: ["./routes/payouts"] }),
    entry("api/middleware/auth.ts"),
    entry("lib/util.ts", { staticFlags: ["handles-auth"] }),
    entry("api/routes/payouts.test.ts", { imports: ["./payouts"] }),
    entry("docs/readme.md"),
  ];
  const picks = selectBundleEntries(target, all).map((p) => `${p.role}:${p.entry.path}`);
  assert.deepEqual(picks, [
    "import:api/routes/ledger.ts",
    "dependent:api/app.ts",
    "control:api/middleware/auth.ts",
    "control:lib/util.ts",
  ]);
});

test("buildEvidenceBundle wraps each file under one token, caps the file count and tolerates fetch failures", async () => {
  const target = entry("api/routes/payouts.ts");
  const all = [target, ...Array.from({ length: 12 }, (_, i) => entry(`api/controllers/c${i}.ts`))];
  const bundle = await buildEvidenceBundle({
    entry: target,
    allEntries: all,
    token: "TOK",
    fetch: async (e) => {
      if (e.path.endsWith("c1.ts")) throw new Error("boom");
      return `// ${e.path}\n`;
    },
  });
  assert.equal(bundle.token, "TOK");
  assert.equal(bundle.files.length, BUNDLE_MAX_FILES);
  assert.ok(bundle.truncated);
  assert.ok(!bundle.files.some((f) => f.path.endsWith("c1.ts")));
  assert.equal((bundle.rendered.match(/<<<BEGIN_UNTRUSTED_BUNDLE_FILE_TOK>>>/g) ?? []).length, BUNDLE_MAX_FILES);
});

test("coerceVerdicts accepts well-formed verdicts and drops malformed items", () => {
  const bad = coerceVerdicts({ verdicts: "nope" });
  assert.ok(!bad.ok);
  const ok = coerceVerdicts({
    verdicts: [
      { index: 0, status: "confirmed", evidence: [{ path: "a.ts", quote: "x" }], severity: "bogus", reasoning: "r" },
      { index: "1", status: "confirmed", evidence: [], severity: "high", reasoning: "" },
      { index: 2, status: "maybe", evidence: [], severity: "high", reasoning: "" },
    ],
  });
  assert.ok(ok.ok);
  assert.equal(ok.value.length, 1);
  assert.equal(ok.value[0].severity, "unchanged");
});

const files = [
  { path: "api/routes/payouts.ts", content: CONTENT },
  { path: "api/app.ts", content: `app.use("/api", requireAuth, router);\n` },
];
const raw = (over: Partial<RawVerdict>): RawVerdict => ({
  index: 0,
  status: "confirmed",
  evidence: [],
  severity: "unchanged",
  reasoning: "because",
  ...over,
});

test("enforceCitations: a confirmation needs a citation that code can find", () => {
  const [good] = enforceCitations(
    [raw({ evidence: [{ path: "payouts.ts", quote: "const accountId = req.body.accountId;" }] })],
    1, files, 5, "m"
  );
  assert.equal(good.status, "confirmed");
  assert.deepEqual(good.evidence[0], { path: "api/routes/payouts.ts", line: 2, quote: "const accountId = req.body.accountId;" });
  const [bad] = enforceCitations([raw({ evidence: [{ path: "payouts.ts", quote: "nothing like this" }] })], 1, files, 5, "m");
  assert.equal(bad.status, "unverifiable");
  assert.equal(bad.reason, "unverifiable");
});

test("enforceCitations: a refutation needs its control quoted from a provided file", () => {
  const [good] = enforceCitations(
    [raw({ status: "refuted", refutingControl: { path: "api/app.ts", quote: 'app.use("/api", requireAuth, router);' } })],
    1, files, 5, "m"
  );
  assert.equal(good.status, "refuted");
  assert.equal(good.refutingControl?.line, 1);
  const [bad] = enforceCitations([raw({ status: "refuted" })], 1, files, 5, "m");
  assert.equal(bad.status, "unverifiable");
});

test("enforceCitations: a missing index is 'no_verdict', never a confirmation", () => {
  const out = enforceCitations([], 2, files, 5, "m");
  assert.equal(out.length, 2);
  assert.ok(out.every((v) => v.status === "unverifiable" && v.reason === "no_verdict"));
});

test("applyVerdict: confirmed restores the claimed severity and owns confidence; anything else is capped", () => {
  const v = enforceCitations(
    [raw({ evidence: [{ path: "payouts.ts", quote: "const accountId = req.body.accountId;" }] })],
    1, files, 5, "m"
  )[0];
  const yes = applyVerdict(finding(), v);
  assert.equal(yes.confidence, "confirmed");
  assert.equal(yes.scannerConfidence, "needs_human");
  assert.equal(yes.severity, "high");
  const critical = applyVerdict(finding(), { ...v, severity: "critical" });
  assert.equal(critical.severity, "critical");
  const no = applyVerdict(finding({ severity: "critical", confidence: "confirmed" }), enforceCitations([], 1, files, 5, "m")[0]);
  assert.equal(no.confidence, "needs_human");
  assert.equal(no.severity, "medium");
  assert.match(describeVerdict(no.verification), /^held back — verifier returned no verdict/);
});
