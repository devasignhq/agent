// The reason catalogue behind the Security page's triage dialog, plus the
// rules that decide what a ruling teaches. Extracted from screen-security.tsx
// so `node --test` can drive it offline — the runner globs only src/**/*.test.ts
// and never picks up .tsx. No React, no DOM. Same split as security-rescan.ts.
//
// Why a catalogue at all: "False positive" is one button, but a maintainer
// clicks it for at least five unrelated reasons. Feeding all of them into one
// corpus doesn't make the agent sharper — it trains it to go quiet, and on a
// security tool that failure is silent. Splitting the reasons at the click is
// what lets us learn from the corrections and ignore the rest.
import type { SecurityRulingCode, SecurityPrecedent, SecurityFinding } from "./api.ts";

export type RulingAction = "false_positive" | "accept";

export type RulingOption = {
  code: SecurityRulingCode;
  label: string;
  description: string;
  // Teachable codes become precedent the agent carries into later scans — but
  // only with a written rationale, which is what `requiresNote` enforces.
  teaches: boolean;
};

// "The agent got it wrong."
export const FALSE_POSITIVE_OPTIONS: RulingOption[] = [
  {
    code: "control_exists",
    label: "The control exists elsewhere",
    description:
      "Auth, validation, or escaping is applied in middleware, a wrapper, or a layer this file doesn't show.",
    teaches: true,
  },
  {
    code: "not_reachable",
    label: "Nothing untrusted reaches this",
    description: "The sink is real, but no attacker-controlled input can flow to it.",
    teaches: true,
  },
  {
    code: "misread_code",
    label: "The agent misread the code",
    description: "The claim is factually untrue about what this code actually does.",
    teaches: true,
  },
  {
    code: "out_of_scope",
    label: "Not our code",
    description: "Vendored, generated, sample, or test-fixture code we don't own.",
    teaches: false,
  },
  {
    code: "duplicate",
    label: "Already tracked",
    description: "Another finding covers this same issue.",
    teaches: false,
  },
];

// "The agent is right, and we're living with it."
export const ACCEPT_OPTIONS: RulingOption[] = [
  {
    code: "by_design",
    label: "Intentional and reviewed",
    description: "This behaviour is deliberate and the team has looked at it.",
    teaches: true,
  },
  {
    code: "compensating_control",
    label: "Mitigated outside the code",
    description: "A WAF, network policy, IaC rule, or manual process handles this.",
    teaches: true,
  },
  {
    code: "accepted_cost",
    label: "Real, not fixing now",
    description: "A risk we're consciously carrying for the time being.",
    teaches: false,
  },
];

export function optionsFor(action: RulingAction): RulingOption[] {
  return action === "accept" ? ACCEPT_OPTIONS : FALSE_POSITIVE_OPTIONS;
}

export function findOption(code: SecurityRulingCode): RulingOption | null {
  return [...FALSE_POSITIVE_OPTIONS, ...ACCEPT_OPTIONS].find((o) => o.code === code) ?? null;
}

export function teaches(code: SecurityRulingCode | null | undefined): boolean {
  return !!code && !!findOption(code)?.teaches;
}

// Matches the backend's clamp on `reason`, so the counter never promises more
// than the server will store.
export const NOTE_MAX = 500;

// A teachable code without a rationale gives the agent nothing to reason with —
// it would read as "stay quiet about this", which is the thing we're avoiding.
// So the note is required exactly where the ruling would otherwise teach.
export function requiresNote(code: SecurityRulingCode | null): boolean {
  return teaches(code);
}

export type RulingDraft = {
  code: SecurityRulingCode | null;
  note: string;
  applyToAllRepos: boolean;
};

export type RulingValidation =
  | { ok: true; body: { code: SecurityRulingCode; reason: string; scope: "repo" | "account" } }
  | { ok: false; error: string };

export function validateRuling(draft: RulingDraft): RulingValidation {
  if (!draft.code) return { ok: false, error: "Pick the reason that fits." };
  const note = draft.note.trim().slice(0, NOTE_MAX);
  if (requiresNote(draft.code) && !note) {
    return {
      ok: false,
      error: "Add a sentence explaining why — that explanation is what the agent learns from.",
    };
  }
  return {
    ok: true,
    body: {
      code: draft.code,
      reason: note,
      // Scope only means anything for a ruling that teaches.
      scope: draft.applyToAllRepos && teaches(draft.code) ? "account" : "repo",
    },
  };
}

// The "apply to all my repos" control is only meaningful for a code that gets
// carried into future scans, so it stays hidden for the rest.
export function canPromoteToAccount(code: SecurityRulingCode | null): boolean {
  return teaches(code);
}

// What the dialog tells the user will happen. Written plainly on purpose: a
// maintainer suppressing a security finding should know exactly how far the
// suppression reaches before they confirm it.
export function outcomeSummary(draft: RulingDraft): string {
  if (!draft.code) return "";
  if (!teaches(draft.code)) {
    return "This finding is suppressed. Nothing is added to the agent's corpus.";
  }
  return draft.applyToAllRepos
    ? "Suppressed here, and the agent will weigh your reasoning on every repo in this account. It won't auto-hide findings outside this repo."
    : "Suppressed here, and the agent will apply your reasoning to future scans of this repo.";
}

// --- the rulings ledger ----------------------------------------------------

export function isSuppressedByRuling(f: SecurityFinding): boolean {
  return !!f.suppressedByPrecedentId;
}

// Findings the agent muted on its own, newest first. These never appear in the
// active list, so this section is the only place they are visible — which is
// the whole reason auto-suppression is safe to ship.
export function suppressedByRulings(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.filter(isSuppressedByRuling).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function precedentById(
  list: SecurityPrecedent[]
): Map<string, SecurityPrecedent> {
  return new Map(list.map((p) => [p.id, p]));
}

// A ruling that needs another look, and why in plain words. "contradicted"
// matters most: the agent muted something a human later treated as real.
export function reconfirmReason(p: SecurityPrecedent): string | null {
  if (p.status !== "needs_reconfirm") return null;
  return p.statusReason === "contradicted"
    ? "A finding this ruling had suppressed was later treated as real."
    : "The code this ruling was made about has changed.";
}

export function activePrecedents(list: SecurityPrecedent[]): SecurityPrecedent[] {
  return list.filter((p) => p.status !== "revoked");
}

// Group the corpus for display: rulings needing a second look float to the top,
// then the ones doing the most muting.
export function sortPrecedents(list: SecurityPrecedent[]): SecurityPrecedent[] {
  const rank = (p: SecurityPrecedent) => (p.status === "needs_reconfirm" ? 0 : 1);
  return [...list].sort(
    (a, b) => rank(a) - rank(b) || b.suppressedCount - a.suppressedCount || b.createdAt - a.createdAt
  );
}
