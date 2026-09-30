// Whether a security finding has been proven real by an executed control + probe
// test pair (or a deterministic rule). Pure; the gate itself lives in proof-gate.ts.
import type { FindingPresentation, SecurityFinding, SecurityProof, SecurityProofReason } from "../types.js";

export const PROOF_ENGINE = "proof-v1";
export const MIN_PROBE_ATTEMPTS = 2;

export type AttemptOutcome = "pass" | "fail" | "error";
export type Outcome = AttemptOutcome | "flaky";
export type ProofVerdict = {
  status: "verified" | "not_reproduced" | "inconclusive";
  reason?: SecurityProofReason;
};

export function aggregateAttempts(attempts: AttemptOutcome[]): Outcome {
  if (!attempts.length || attempts.includes("error")) return "error";
  if (attempts.every((a) => a === "pass")) return "pass";
  if (attempts.every((a) => a === "fail")) return "fail";
  return "flaky";
}

// A failed control means the test is broken, not the app — a wrong URL's 404
// would otherwise read as "access denied" and pass as a protection.
export function judgeProof(args: { control: AttemptOutcome[]; probe: AttemptOutcome[] }): ProofVerdict {
  const control = aggregateAttempts(args.control);
  if (control !== "pass") {
    const reason = control === "fail" ? "control_failed" : control === "flaky" ? "flaky" : "test_errored";
    return { status: "inconclusive", reason };
  }
  const probe = aggregateAttempts(args.probe);
  if (probe === "pass") return { status: "not_reproduced" };
  if (probe === "fail") {
    return args.probe.length >= MIN_PROBE_ATTEMPTS
      ? { status: "verified" }
      : { status: "inconclusive", reason: "single_attempt" };
  }
  return { status: "inconclusive", reason: probe === "flaky" ? "flaky" : "test_errored" };
}

export function untestedProof(now: number, reason?: SecurityProofReason): SecurityProof {
  return { status: "untested", method: "test", ...(reason ? { reason } : {}), engine: PROOF_ENGINE, updatedAt: now };
}

function isStaleFor(p: SecurityProof, blobSha: string): boolean {
  return p.status !== "untested" && !!p.blobSha && p.blobSha !== blobSha;
}

// Keeps the run pointers so a later phase can re-run the stored test.
function asStale(p: SecurityProof, updatedAt: number): SecurityProof {
  const { detail: _detail, attempts: _attempts, ...rest } = p;
  return { ...rest, status: "untested", reason: "stale", updatedAt };
}

// A proof only speaks for the file blob it ran against.
export function effectiveProof(f: Pick<SecurityFinding, "proof" | "detectedSha">): SecurityProof {
  const p = f.proof;
  if (!p) return untestedProof(0);
  return isStaleFor(p, f.detectedSha) ? asStale(p, p.updatedAt) : p;
}

// The proof to persist once a scan sees the file at `blobSha`; same object when nothing changed.
export function refreshProof(p: SecurityProof | undefined, blobSha: string, now: number): SecurityProof {
  if (!p) return untestedProof(now);
  return isStaleFor(p, blobSha) ? asStale(p, now) : p;
}

export function isProven(f: Pick<SecurityFinding, "proof" | "detectedSha">): boolean {
  return effectiveProof(f).status === "verified";
}

// Read-time placement under the proof gate. States are never rewritten for
// proof, so turning the gate off restores today's view exactly.
export function presentationOf(f: SecurityFinding): FindingPresentation {
  if (f.state === "accepted" || f.state === "false_positive") return "suppressed";
  if (f.state === "resolved") return "resolved";
  if (isProven(f)) return "main";
  if (f.issueNumber != null || f.bountyId != null) return "kept";
  return "untested";
}
