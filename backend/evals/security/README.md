# Security audit benchmark

Ground truth for the security audit: a fixture app whose vulnerabilities — and
whose safe-but-suspicious-looking code — we know in advance, so a change to the
scanner, the verifier, or the proof rule can be measured instead of guessed.

It exists because findings the LLM verifier called "confirmed" were still false in
production. The benchmark's headline number is **how many decoys come out
surfaced**: those are the false reports a customer sees.

## Layout

```
vendor/secbench/
  app-vulnerable/   the subject, with 5 real bugs
  app-fixed/        identical except those 5 files
  cases/<id>.ts     one control + probe pair per case
  manifest.json     the only record of which cases are real
  truth.test.ts     proves the ground truth by running it
  harness.ts        boots a tree in-process; also the reachability walk
```

`vendor/` is deliberate: the repo indexer skips it (`src/review/indexer.ts`), so
DevAsign's own production audit never scans the fixture or its attack payloads.
The path is also in the root `.devasign.yml` `review.ignore_paths`, and `evals` is
in `.dockerignore`.

**The fixture carries no hints.** No "vulnerable" or "decoy" in any name or
comment — the scanner sees ordinary code. The answers live only in `manifest.json`.

## Cases

| id | kind | what it is |
|----|------|------------|
| R1 | real | invoice lookup authenticated but not tenant-scoped |
| R2 | real | invoice search builds SQL by concatenation |
| R3 | real | download joins a path parameter with no containment check |
| R4 | real | billing webhook applies events without checking the signature |
| R5 | real | report fetch takes its URL from the request body |
| D1 | decoy | admin routes have no inline check; `requireAdmin` is mounted in `app.ts` |
| D2 | decoy | order handler reads an id from the URL; its repository is tenant-bound |
| D3 | decoy | concatenated SQL in a dev script the service never imports |
| D4 | decoy | thumbnail route joins a path param behind a router-level validator |
| D5 | decoy | placeholder secret in a committed sample config |
| D6 | decoy | partner sync shows no verification; middleware checks the signature |

## Proving the ground truth

```bash
npm --prefix backend run test:secbench
```

Each case runs its control (the legitimate path, which must pass) and its probe
(the attack, which must fail on an assertion) twice per tree, and is judged by the
**production** `judgeProof` from `src/security/proof.ts`. Expected: R1–R5 verified
on `app-vulnerable` and not_reproduced on `app-fixed`; every runtime decoy
not_reproduced on both; D3 unreachable from `src/server.ts`.

Two invariants are enforced alongside: the trees may differ **only** in the
manifest's real-bug files, and a case may import nothing but the harness and
`node:assert`. Part of `npm test`, so the benchmark cannot rot silently.

Verified load-bearing (2026-09-28): patching the bug out of `app-vulnerable`
flipped R1 from verified to not_reproduced and failed the tree-diff invariant, so
these tests can actually fail.

## Scoring the pipeline against it

```bash
npm --prefix backend run eval:security -- --runs 3 --out /tmp/sec-baseline.json
```

Runs the production audit path (`scanFile` → `mechanicalCheck` →
`buildEvidenceBundle` → `verifyFindings` → `applyVerdict`) over each tree with no
GitHub, scoring with `src/security/bench-score.ts`. Flags: `--tree`, `--case`,
`--runs`, `--concurrency`, `--no-summariser`, `--out`.

Two deliberate properties:

- **A failed scan is `scan_failed`, never "clean."** Without this, an unreachable
  model would read as a perfect zero-false-positive run.
- **Without credentials it refuses to score** and says it is a smoke test only.

To mirror production, run it on Vertex/Gemini:

```bash
LLM_PROVIDER=vertex VERTEX_PROJECT=<prod project> VERTEX_THINKING=medium \
  npm --prefix backend run eval:security -- --runs 3 --out /tmp/sec-baseline.json
```

## Baseline

**2026-09-30 · Gemini 3.8 Flash on Vertex, medium thinking (prod's configuration) ·
3 runs per tree · ~$0.68 per pass.**

| tree | real bugs surfaced | decoys surfaced | noise | scan failures |
|---|---|---|---|---|
| vulnerable, 3 runs | **5/5, 5/5, 5/5** | 0/6 every run | 2–4 | 0 |
| fixed, 3 runs | 0/5, 0/5, **1/5** | 0/6 every run | 2–4 | 0 |

Per-case surfacing rate across all 6 runs: R1–R4 3/6 (exactly the three vulnerable
runs), R5 4/6, every decoy **0/6**.

**Read this honestly: on this fixture the current pipeline did well.** No decoy was
ever surfaced. D1 — authorization applied where the router is mounted, the case
this whole project was motivated by — was *refuted* by the verifier in every run,
with the right reason. That is the failure mode we expected to catch, and the
verifier handled it.

Two things the run did show:

1. **One reproducible false positive.** R5 (SSRF) surfaced against the *fixed*
   tree in 1 of 3 runs — a confirmed finding about code that already has the
   control. That is the exact class of report this work exists to suppress.
2. **The pipeline is not deterministic.** Identical inputs, different verdicts
   between runs. A finding's fate currently depends partly on which run you got,
   which is itself an argument for deciding it with an executed test rather than
   a second opinion.

Consistent non-case findings (counted as noise here, but real): `db/billing.ts`
lacks idempotency on credit application — confirmed in all 6 runs — and the webhook
signature check has no replay protection, correctly held as `unverifiable`. Both are
genuine gaps in the fixture that the manifest does not track.

**What this does not tell us.** The benchmark did not reproduce the false-positive
rate seen in production, so whatever drives that is not yet in the fixture —
plausibly scale (real repos exceed the 8-file evidence bundle), framework-driven
wiring, or config-based controls. The production aggregates (see the plan's SQL)
are currently the only evidence about which mode actually dominates, and the
fixture should grow toward whatever they show.
