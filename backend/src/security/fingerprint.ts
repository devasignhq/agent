// Stable identity for security findings. The audit agent re-derives findings
// from scratch on every scan; the fingerprint is what lets a re-detection match
// the existing row (keeping its triage state — issue links, accepted-risk,
// assignee) instead of minting a duplicate. Line numbers and prose wording are
// deliberately excluded: both drift between runs on the same underlying issue.
// Pure module — no db/network — so it is testable offline.
import { createHash } from "node:crypto";
import type { AttackSurface } from "../types.js";

// Collapse a free-text slug/title into a wording-tolerant token: lowercase,
// alphanumerics only. "Missing auth on payout route" and "missing-auth-on-
// payout-route!" fingerprint identically.
export function normalizeSlug(text: string): string {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 120);
}

export function fingerprintFinding(args: {
  repoId: string;
  path: string;
  class: string;
  slug: string;      // the model's stable_key (falls back to the title)
  symbol?: string;
}): string {
  // Prefer the symbol over the slug when the model localized one: a function
  // name survives rewording far better than any prose. The class keeps two
  // different vulns in the same symbol distinct.
  const anchor = args.symbol ? normalizeSlug(args.symbol) : normalizeSlug(args.slug);
  const key = `${args.repoId}|${args.path}|${normalizeSlug(args.class)}|${anchor}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// Deterministic path → attack-surface mapping. The model's class can override
// (a hardcoded secret in a frontend file is still surface "secrets"), which
// classifySurfaceFor handles; this is the structural default.
export function classifySurface(path: string): AttackSurface {
  const p = path.toLowerCase();
  const base = p.split("/").pop() || p;
  // Dependency manifests
  if (/(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.mod|go\.sum|cargo\.toml|cargo\.lock|requirements[^/]*\.txt|pipfile|poetry\.lock|gemfile|composer\.json)$/.test(p)) {
    return "deps";
  }
  // Infra: IaC, CI, containers, k8s manifests
  if (
    /\.(tf|tfvars)$/.test(base) ||
    /(^|\/)(dockerfile|docker-compose[^/]*\.ya?ml)$/.test(p) ||
    /(^|\/)\.github\/workflows\//.test(p) ||
    /(^|\/)(infra|terraform|deploy|k8s|kubernetes|helm|charts|ansible)\//.test(p) ||
    /\.(ya?ml)$/.test(base) && /(deploy|infra|k8s|helm|ci|pipeline)/.test(p)
  ) {
    return "infra";
  }
  // Frontend: client app trees + UI component extensions
  if (
    /(^|\/)(frontend|contributor|web|client|ui|www|pages|components)\//.test(p) ||
    /\.(tsx|jsx|vue|svelte|html|css|scss)$/.test(base)
  ) {
    return "frontend";
  }
  return "api";
}

// The model's class wins for secrets — a committed credential is surface
// "secrets" wherever the file lives.
export function classifySurfaceFor(path: string, cls: string): AttackSurface {
  const c = normalizeSlug(cls);
  if (c.includes("secret") || c.includes("credential") || c.includes("hardcodedkey")) return "secrets";
  return classifySurface(path);
}
