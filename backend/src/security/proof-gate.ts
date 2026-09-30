// The proof gate: whether a repo presents and gates only test-proven findings.
// Every flag-aware read of findings goes through here so the rule lives in one place.
import { db } from "../db.js";
import { effectiveWorkflow } from "../review/workflow.js";
import { checkGate, GATES } from "../statsig.js";
import type { FindingPresentation, Repository, SecurityFinding } from "../types.js";
import { effectiveSecurityPolicy } from "./policy.js";
import { effectiveProof, presentationOf } from "./proof.js";

export type ProofMode = "off" | "statsig" | "on";
export type ProofReadiness = "ready" | "needs_setup" | "needs_opt_in";

// Read per call so tests and ops can flip it without a restart.
export function proofMode(): ProofMode {
  const v = (process.env.SECURITY_PROOF_MODE || "").trim().toLowerCase();
  return v === "on" || v === "statsig" ? v : "off";
}

// Keyed on the install owner, like the audit and the merge gate, so every
// co-maintainer sees the same thing the check-run enforces.
export function proofGateFor(repo: Pick<Repository, "installationId">): boolean {
  const mode = proofMode();
  if (mode !== "statsig") return mode === "on";
  const install = db.find("installations", (i) => i.id === repo.installationId);
  if (!install) return false;
  const owner = db.find("users", (u) => u.id === install.userId) ?? install.userId;
  return checkGate(owner, GATES.securityProof, false);
}

export function proofReadiness(repo: Repository): ProofReadiness {
  const onboarded = repo.verify?.onboarding?.state === "verified" && effectiveWorkflow(repo).stages.verify !== false;
  if (!onboarded) return "needs_setup";
  if (!repo.private && !effectiveSecurityPolicy(repo).proof.publicOptIn) return "needs_opt_in";
  return "ready";
}

export type FindingView<T extends SecurityFinding = SecurityFinding> = T & { presentation?: FindingPresentation };

// Off returns the row untouched, so the API payload is unchanged until the gate flips.
export function findingView<T extends SecurityFinding>(f: T, gateOn: boolean): FindingView<T> {
  if (!gateOn) return f;
  return { ...f, proof: effectiveProof(f), presentation: presentationOf(f) };
}
