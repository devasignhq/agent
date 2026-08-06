// One-click GitHub issue creation from a security finding — the first place
// the app CREATES an issue (everywhere else only comments on existing ones).
// The created issue is the handoff point to the existing Bounties flow: a
// sponsor posts a bounty against the issue, and live.ts flips the finding to
// state "bounty" when one appears.
import { config } from "../config.js";
import { db } from "../db.js";
import { gh, installationPermissions } from "../github/app.js";
import type { Installation, Repository, SecurityFinding } from "../types.js";
import { contradictPrecedent } from "./precedent-store.js";

export class IssueCreationError extends Error {
  code: "missing_issues_permission" | "github_error";
  constructor(code: "missing_issues_permission" | "github_error", message: string) {
    super(message);
    this.code = code;
  }
}

// Issue body: the finding contract rendered for a contributor who has never
// seen the Security page — everything needed to reproduce and fix, plus the
// deep link back for the sponsor.
export function findingIssueBody(finding: SecurityFinding): string {
  const lines: string[] = [];
  const loc = `\`${finding.path}${finding.line ? `:${finding.line}` : ""}\``;
  lines.push(
    `**Severity:** ${finding.severity}` +
      (finding.cwe ? ` · **${finding.cwe}**` : "") +
      ` · **Surface:** ${finding.surface}` +
      ` · **Confidence:** ${finding.confidence.replace("_", " ")}`
  );
  lines.push("");
  lines.push(`**Location:** ${loc}${finding.symbol ? ` (\`${finding.symbol}\`)` : ""}`);
  lines.push("");
  lines.push("### What's wrong");
  lines.push(finding.concern);
  if (finding.evidence) {
    lines.push("");
    lines.push("### Evidence");
    lines.push("```");
    lines.push(finding.evidence);
    lines.push("```");
  }
  if (finding.exploitNarrative?.length) {
    lines.push("");
    lines.push("### Exploit path");
    finding.exploitNarrative.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  if (finding.blastRadius) {
    lines.push("");
    lines.push(`**Blast radius:** ${finding.blastRadius}`);
  }
  if (finding.invariant) {
    lines.push(`**Invariant:** ${finding.invariant}`);
  }
  if (finding.remediation) {
    lines.push("");
    lines.push("### Suggested fix");
    lines.push(finding.remediation);
  }
  if (finding.regressionTest) {
    lines.push("");
    lines.push("### Regression test");
    lines.push(finding.regressionTest);
  }
  lines.push("");
  lines.push("---");
  lines.push(
    `Found by the DevAsign security audit · [view this finding](${config.webOrigin}/security/findings/${finding.id})`
  );
  return lines.join("\n");
}

// Create the GitHub issue for a finding and stamp it onto the row. Idempotent:
// an existing issueNumber short-circuits (the route also checks, but a webhook
// redelivery or double-click must never file twice). Throws IssueCreationError
// so the route can surface a real message behind the button.
export async function createFindingIssue(args: {
  repo: Repository;
  install: Installation;
  finding: SecurityFinding;
  actorLogin: string;
}): Promise<{ issueNumber: number; issueUrl: string }> {
  const { repo, install, finding, actorLogin } = args;
  if (finding.issueNumber != null && finding.issueUrl) {
    return { issueNumber: finding.issueNumber, issueUrl: finding.issueUrl };
  }

  let created: { number: number; html_url: string };
  try {
    created = await gh<{ number: number; html_url: string }>(
      install.installationId,
      `/repos/${repo.owner}/${repo.name}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `[Security] ${finding.title}`,
          body: findingIssueBody(finding),
          labels: ["security"],
        }),
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A 403 usually means the installation predates the App's issues:write
    // permission — diagnose so the UI can say exactly that.
    if (/403/.test(msg)) {
      try {
        const perms = await installationPermissions(install.installationId);
        if (perms && perms.issues !== "write") {
          throw new IssueCreationError(
            "missing_issues_permission",
            "The GitHub App installation doesn't grant Issues write access. Accept the updated permissions on GitHub and retry."
          );
        }
      } catch (e) {
        if (e instanceof IssueCreationError) throw e;
        // fall through to generic
      }
    }
    throw new IssueCreationError("github_error", `GitHub issue creation failed: ${msg.slice(0, 200)}`);
  }

  const now = Date.now();
  // Filing an issue from a finding a prior ruling had muted contradicts that
  // ruling — retire it before it mutes anything else.
  contradictPrecedent(finding);
  db.update("securityFindings", (f) => f.id === finding.id, {
    state: "issue_created",
    suppressedByPrecedentId: null,
    issueNumber: created.number,
    issueUrl: created.html_url,
    activity: [
      ...(finding.activity ?? []),
      {
        at: now,
        kind: "issue_created" as const,
        detail: `GitHub issue #${created.number} created`,
        actor: actorLogin,
      },
    ].slice(-50),
  });
  return { issueNumber: created.number, issueUrl: created.html_url };
}
