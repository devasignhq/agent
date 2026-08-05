// The security audit agent's per-file scanner. Distinct from the review
// pipeline's "did this diff introduce a vuln" check: this is the whole-codebase
// auditor that runs after every merge to the default branch (audit.ts drives
// it). The operating rules are the Tier 1/Tier 2 SaaS audit contract:
// inventory-first, prove-don't-assume, exploit-narrative-or-drop, precision
// over noise, report-don't-fix.
import { config } from "../config.js";
import { complete } from "../llm.js";
import type { AttackSurface, RepoSecurityPolicy, SecurityConfidence, SecuritySeverity } from "../types.js";
import { capSeverityByConfidence, normalizeConfidence, normalizeSeverity } from "./severity.js";
import { classifySurfaceFor } from "./fingerprint.js";

export const AUDIT_MODEL = config.llm.model;
const MAX_LLM_RETRIES = 3;
const MAX_FINDINGS_PER_FILE = 15;

// A finding as the model reports it, before reconciliation assigns identity.
export type AgentFinding = {
  slug: string;                 // model's stable_key for cross-run identity
  class: string;
  cwe?: string;
  surface: AttackSurface;
  severity: SecuritySeverity;
  confidence: SecurityConfidence;
  title: string;
  concern: string;
  evidence?: string;
  dataflow?: { source: string; sink: string; steps: string[] };
  exploitNarrative?: string[];  // exactly 3 steps — enforced by buildFindingRows
  blastRadius?: string;
  invariant?: string;
  remediation?: string;
  regressionTest?: string;
  symbol?: string;
  line?: number;
};

// The audit contract, distilled from the Tier 1/Tier 2 operating prompt. The
// per-file scanner can't do cross-file inventory itself — the audit job's file
// gate (securityFlags) is the inventory step — so the prompt focuses the model
// on per-file provability and the finding contract.
const SECURITY_AUDIT_SYSTEM =
  "You are DevAsign's security audit agent, auditing one file of a multi-tenant B2B SaaS codebase. " +
  "Severity is ranked by BLAST RADIUS, not likelihood: a bug that leaks one tenant's data to another ends every " +
  "enterprise contract at once.\n\n" +
  "Look for the bug classes that actually kill SaaS companies — most are the ABSENCE of a control, not the presence " +
  "of a pattern:\n" +
  "- Tenant isolation: queries/cache keys/storage paths/background jobs missing the tenant scope; IDs read from the " +
  "request instead of the session; IDOR (unguessability is not authorization); mass assignment of tenant_id/role/owner.\n" +
  "- AuthN/AuthZ: routes missing auth middleware, authz re-implemented per endpoint and drifting, object-level checks " +
  "missing, admin/debug/impersonation paths without gates or audit logs.\n" +
  "- CI/CD & supply chain: untrusted-code triggers with secrets in scope, script injection from event fields, unpinned " +
  "third-party actions/images, install scripts, dependency confusion.\n" +
  "- Credentials: secrets committed in source, long-lived static keys, tokens without expiry/revocation, secrets in " +
  "logs/error payloads/URLs.\n" +
  "- Logic, concurrency & money paths: missing idempotency on value-bearing endpoints, TOCTOU between check and " +
  "write, read-modify-write on balances, state machines that can skip or re-enter states, unverified webhook " +
  "signatures (must verify raw body, constant-time, with replay protection).\n" +
  "- Injection & sinks: SQL/command/template injection, XSS via unescaped sinks, SSRF (blocklists and " +
  "resolve-then-reconnect TOCTOU are bypassable), path traversal, unsafe deserialization, weak crypto.\n" +
  "- Data at rest: PII/tokens in logs, prod data in fixtures, missing encryption where the file clearly handles " +
  "sensitive data.\n" +
  "- Prompt injection: untrusted content concatenated into LLM prompts while the agent holds tools or credentials; " +
  "model output passed to a shell, query, HTML sink, or file path.\n\n" +
  "NON-NEGOTIABLE RULES:\n" +
  "1. Report ONLY what is verifiable in the provided file content. Never infer from the filename or framework " +
  "conventions. Never invent line numbers — cite only lines you can see.\n" +
  "2. If you cannot write a concrete 3-step exploit narrative, it is NOT a finding — drop it.\n" +
  "3. A control may exist outside this file (middleware applied elsewhere, a WAF, IaC). When your finding depends on " +
  'such an assumption, set confidence to "needs_human" and name the assumption in the concern. Severity is capped by ' +
  'confidence — enforced in code after you respond: only "confirmed" findings, where you verified in THIS file that ' +
  "the control is absent and quoted the decisive evidence line, may be rated critical or high. Anything resting on an " +
  "unverified assumption is at most medium, no matter its potential blast radius.\n" +
  "4. Prefer under-reporting with high precision over comprehensive noise. An empty array is a good answer for a " +
  "clean file.\n" +
  "5. You report; you do not fix. The remediation is advice for a human or coding agent.\n\n" +
  'Emit ONLY JSON: {"findings": [{' +
  '"stable_key": string,           // short kebab-case identity for THIS issue, stable across re-scans (e.g. "payout-route-missing-auth"). Never include line numbers.\n' +
  '"class": string,                // taxonomy tag: "sql-injection", "missing-authz", "hardcoded-secret", "idor", "ssrf", "missing-idempotency", "prompt-injection", ...\n' +
  '"cwe": string?,                 // "CWE-89" when one clearly applies\n' +
  '"severity": "critical"|"high"|"medium"|"low",   // by blast radius: critical = cross-tenant access, auth bypass, unauthorized fund movement, pipeline compromise; high = single-tenant compromise, credential exposure, privilege escalation; medium = needs chaining / missing defense-in-depth; low = hardening only. Critical/high require confidence "confirmed" (rule 3)\n' +
  '"confidence": "confirmed"|"probable"|"needs_human",   // confirmed = you verified in this file that the control is absent (quote the evidence); probable = strong evidence but an unverified assumption remains; needs_human = depends on something outside this file\n' +
  '"title": string,                // one line, specific ("payout endpoint lacks idempotency enforcement")\n' +
  '"concern": string,              // what it is and why it is exploitable, 2-4 sentences\n' +
  '"evidence": string,             // the decisive line(s), quoted from the file with the line number you actually see\n' +
  '"symbol": string?,              // enclosing function/class, when identifiable\n' +
  '"line": number?,                // 1-based line of the evidence, only if certain\n' +
  '"dataflow": {"source": string, "sink": string, "steps": [string]}?,   // source→sink trace when applicable\n' +
  '"exploit_narrative": [string, string, string],   // EXACTLY 3 concrete attacker steps\n' +
  '"blast_radius": string,         // one sentence: what an attacker gets\n' +
  '"invariant": string,            // the rule that should hold\n' +
  '"remediation": string,          // code-level fix a human or coding agent can apply; name files/symbols, not "use best practices"\n' +
  '"regression_test": string       // a test that fails today and passes after the fix\n' +
  "}]}";

// Coerce the model's output into hardened AgentFinding rows: drop items without
// a concern/title or without the mandatory 3-step exploit narrative, clamp
// enums, cap severity at medium unless confidence is "confirmed" (and refuse
// "confirmed" without quoted evidence), cap the per-file count. Exported for
// offline testing.
export function buildFindingRows(raw: unknown, path: string): AgentFinding[] {
  const parsed = raw && typeof raw === "object" ? (raw as any) : {};
  const list = Array.isArray(parsed.findings) ? parsed.findings : [];
  const out: AgentFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const it = item as any;
    const title = String(it.title || "").trim().slice(0, 200);
    const concern = String(it.concern || "").trim();
    if (!title || !concern) continue;
    // Rule 2: no 3-step exploit narrative → not a finding.
    const narrative = Array.isArray(it.exploit_narrative)
      ? it.exploit_narrative.filter((s: unknown) => typeof s === "string" && String(s).trim()).map((s: string) => s.trim().slice(0, 500))
      : [];
    if (narrative.length < 3) continue;
    const cls = (String(it.class || "").trim() || "unspecified").slice(0, 60);
    const cwe = String(it.cwe || "").trim();
    const slug = String(it.stable_key || "").trim() || title;
    const symbol = typeof it.symbol === "string" && it.symbol.trim() ? it.symbol.trim().slice(0, 120) : undefined;
    const line = typeof it.line === "number" && Number.isFinite(it.line) && it.line > 0 ? Math.floor(it.line) : undefined;
    const df = it.dataflow;
    const dataflow =
      df && typeof df === "object" && typeof df.source === "string" && typeof df.sink === "string"
        ? {
            source: String(df.source).slice(0, 300),
            sink: String(df.sink).slice(0, 300),
            steps: Array.isArray(df.steps)
              ? df.steps.filter((s: unknown) => typeof s === "string").map((s: string) => s.slice(0, 300)).slice(0, 10)
              : [],
          }
        : undefined;
    const str = (v: unknown, cap: number) => {
      const s = typeof v === "string" ? v.trim() : "";
      return s ? s.slice(0, cap) : undefined;
    };
    const evidence = str(it.evidence, 1000);
    // "Confirmed" means the agent verified the control is absent — a claim it
    // must substantiate by quoting the decisive line. No evidence, no
    // confirmation.
    let confidence = normalizeConfidence(it.confidence);
    if (confidence === "confirmed" && !evidence) confidence = "needs_human";
    out.push({
      slug: slug.slice(0, 120),
      class: cls,
      ...(cwe && /^cwe-\d+$/i.test(cwe) ? { cwe: cwe.toUpperCase() } : {}),
      surface: classifySurfaceFor(path, cls),
      severity: capSeverityByConfidence(normalizeSeverity(it.severity), confidence),
      confidence,
      title,
      concern: concern.slice(0, 2000),
      ...(evidence ? { evidence } : {}),
      ...(dataflow ? { dataflow } : {}),
      exploitNarrative: narrative.slice(0, 3),
      ...(str(it.blast_radius, 300) ? { blastRadius: str(it.blast_radius, 300) } : {}),
      ...(str(it.invariant, 300) ? { invariant: str(it.invariant, 300) } : {}),
      ...(str(it.remediation, 3000) ? { remediation: str(it.remediation, 3000) } : {}),
      ...(str(it.regression_test, 1500) ? { regressionTest: str(it.regression_test, 1500) } : {}),
      ...(symbol ? { symbol } : {}),
      ...(line != null ? { line } : {}),
    });
    if (out.length >= MAX_FINDINGS_PER_FILE) break;
  }
  return out;
}

function tryParseJSON(text: string): any | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// Scan one file. Mirrors the indexer's retry/429-backoff shape; returns [] on
// persistent failure so one flaky file never sinks the run (the audit job logs
// the miss and the file stays owed — securityScannedSha isn't advanced).
export async function scanFile(args: {
  path: string;
  content: string;
  repoContext?: string; // brief index-derived context (flags, summary)
  engines: RepoSecurityPolicy["engines"];
}): Promise<AgentFinding[] | null> {
  const userText =
    `Path: ${args.path}\n` +
    (args.repoContext ? `Repo context: ${args.repoContext}\n` : "") +
    `\n\`\`\`\n${args.content}\n\`\`\``;
  for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
    try {
      const raw = await complete({
        system: SECURITY_AUDIT_SYSTEM,
        model: AUDIT_MODEL,
        cacheSystem: true,
        messages: [{ role: "user", content: userText }],
        maxTokens: 2500,
      });
      const parsed = tryParseJSON(raw);
      if (!parsed) continue;
      return buildFindingRows(parsed, args.path);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const is429 = /429/.test(msg) || /rate/i.test(msg);
      if (is429 && attempt < MAX_LLM_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
        continue;
      }
      console.warn(`[security] scan ${args.path} failed:`, msg);
      return null;
    }
  }
  return null;
}
