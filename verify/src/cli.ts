// `devasign-verify run` — runs DevAsign's generated acceptance tests in this CI job.
import { parseArgs } from "node:util";
import { detectSetup, readDevasignVerify } from "./detect.js";
import { preflight } from "./doctor.js";
import { log } from "./log.js";
import { actionsTokenSource, staticTokenSource } from "./oidc.js";
import { run } from "./run.js";
import { CLI_VERSION, type FailOn } from "./types.js";

const HELP = `devasign-verify ${CLI_VERSION}

Usage: devasign-verify [run|detect|doctor] [options]

  run      Resolve this PR's test plan from DevAsign, run it, upload evidence (default)
  detect   Print the detected test setup as JSON
  doctor   Print setup diagnostics for end-to-end verification

Options:
  --api-url <url>          DevAsign API origin (env DEVASIGN_API_URL)
  --fail-on <mode>         never (default): always exit 0; verdict: fail the job on a
                           failed criterion; unverifiable: also fail when a criterion
                           could not be verified. Unset: the repo's DevAsign setting
  --audience <aud>         OIDC audience (default devasign)
  --token <jwt>            Use this token instead of the Actions OIDC token (local runs)
  --pr <n> --sha <sha>     Override the PR number / head sha (local runs)
  --resolve-timeout <s>    Max seconds to wait for a plan (default 180; DevAsign
                           may shorten it and re-run this workflow when ready)
  --test-timeout <s>       Per test-file timeout in seconds (default 600)
  --plan-file <path>       Offline: run this plan JSON with no API
  --results-out <path>     Write the results JSON to this path
  --keep                   Keep .devasign/tests and artifacts after the run
  --cwd <dir>              Repository checkout (default cwd)
`;

// `Number(x) || fallback` would turn an explicit 0 — "don't wait" — back into the default.
const seconds = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "api-url": { type: "string" },
      "fail-on": { type: "string" },
      audience: { type: "string" },
      token: { type: "string" },
      pr: { type: "string" },
      sha: { type: "string" },
      "resolve-timeout": { type: "string" },
      "test-timeout": { type: "string" },
      "plan-file": { type: "string" },
      "results-out": { type: "string" },
      keep: { type: "boolean" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return void console.log(HELP), 0;
  if (values.version) return void console.log(CLI_VERSION), 0;
  const command = positionals[0] || "run";
  const cwd = values.cwd || process.cwd();

  if (command === "detect") {
    console.log(JSON.stringify(await detectSetup(cwd), null, 2));
    return 0;
  }
  if (command === "doctor") {
    const setup = await detectSetup(cwd);
    const yml = readDevasignVerify(cwd);
    const d = preflight({ tests: [{ runner: "playwright" } as any], setup, yml, repoHasPlaywrightConfig: !!setup.frameworks.find((f) => f.name === "playwright")?.configPath, env: process.env, nodeVersion: process.version });
    console.log(JSON.stringify({ setup, devasignYml: yml, diagnosis: d }, null, 2));
    return 0;
  }
  if (command !== "run") {
    console.error(HELP);
    return 2;
  }
  const apiUrl = values["api-url"] || process.env.DEVASIGN_API_URL || "";
  if (!apiUrl && !values["plan-file"]) {
    log.error("--api-url (or DEVASIGN_API_URL) is required");
    return 2;
  }
  const failOnValue = values["fail-on"];
  if (failOnValue !== undefined && !["never", "verdict", "unverifiable"].includes(failOnValue)) {
    log.error(`--fail-on must be never, verdict or unverifiable (got "${failOnValue}")`);
    return 2;
  }
  const failOn = failOnValue as FailOn | undefined;
  const tokenValue = values.token || process.env.DEVASIGN_TOKEN;
  const token = tokenValue ? staticTokenSource(tokenValue) : actionsTokenSource(values.audience || process.env.DEVASIGN_OIDC_AUDIENCE || "devasign");
  try {
    return await run({
      apiUrl,
      token,
      failOn,
      resolveTimeoutMs: seconds(values["resolve-timeout"], 180) * 1000,
      testTimeoutMs: seconds(values["test-timeout"], 600) * 1000,
      keep: !!values.keep,
      cwd,
      pr: values.pr ? Number(values.pr) : undefined,
      sha: values.sha,
      planFile: values["plan-file"],
      resultsOut: values["results-out"],
    });
  } catch (err) {
    // The runner must never take the customer's pipeline down: report and exit 0.
    log.error(`verification could not complete: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

// This module is the bundle's only entry point; npm runs it through a bin
// symlink, so an argv/URL comparison here would silently skip main().
main().then((code) => process.exit(code));
