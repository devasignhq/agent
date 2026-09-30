// Tripwire. Under the proof gate an untested finding must not be presented,
// gated on, or announced — and the only thing standing between a new reader of
// `securityFindings` and doing exactly that is remembering the filter. So the set
// of readers is pinned here: adding one fails this test until it is listed, with
// a note about how it treats an unproven finding.
//
// No db / network / LLM. Run:
//   node --import tsx/esm --test src/security/readers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Each entry says how that file stays honest about unproven findings.
const KNOWN_READERS: Record<string, string> = {
  "review/items.ts": "type-only reference; no read of its own",
  "review/prompts.ts": "type-only reference; no read of its own",
  "review/pipeline.ts": "filters through presentablePreexisting(findings, proofGate)",
  "routes/api.ts": "serves findingView(f, proofGateFor(repo)) and refuses untested mutations",
  "security/audit.ts": "writes and reconciles; presentation is decided at read time",
  "security/gate.ts": "passes proofGateFor(repo) into computeGate",
  "security/issue.ts": "refuses an untested finding and renders the proof, not the AI claim",
  "security/live.ts": "SSE fan-out only; carries no severity or verdict",
  "security/migrate.ts": "stamps the proof record; never presents",
  "security/precedent-store.ts": "ruling bookkeeping; restores state, not presentation",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

test("every reader of securityFindings is accounted for under the proof gate", () => {
  const found = sourceFiles(SRC)
    .filter((f) => readFileSync(f, "utf8").includes('"securityFindings"'))
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .sort();

  const known = Object.keys(KNOWN_READERS).sort();
  const added = found.filter((f) => !known.includes(f));
  const gone = known.filter((f) => !found.includes(f));

  assert.deepEqual(
    added,
    [],
    `New reader(s) of securityFindings: ${added.join(", ")}.\n` +
      "Decide how each treats an UNPROVEN finding (it must not be presented, gated on or\n" +
      "announced when the proof gate is on), then add it to KNOWN_READERS with that note."
  );
  assert.deepEqual(gone, [], `KNOWN_READERS lists file(s) that no longer read securityFindings: ${gone.join(", ")}`);
});
