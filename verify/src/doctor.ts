// Setup diagnosis. A first run on an unconfigured repo must explain itself,
// never fail the pipeline, and never pretend a broken setup is a broken PR.
import type { DetectedSetup, DevasignVerifyConfig, DoctorDiagnosis, PlanTest } from "./types.js";

function satisfies(actual: string, range: string): boolean {
  const cur = /v?(\d+)\.(\d+)/.exec(actual);
  const want = /(>=|\^|~)?\s*v?(\d+)(?:\.(\d+))?/.exec(range);
  if (!cur || !want) return true;
  const [major, minor] = [Number(cur[1]), Number(cur[2])];
  const [op, wMajor, wMinor] = [want[1] || "", Number(want[2]), Number(want[3] || 0)];
  if (op === ">=" || op === "^" || op === "") return major > wMajor || (major === wMajor && minor >= wMinor);
  if (op === "~") return major === wMajor && minor >= wMinor;
  return true;
}

export function preflight(args: {
  tests: PlanTest[];
  setup: DetectedSetup;
  yml: DevasignVerifyConfig | null;
  repoHasPlaywrightConfig: boolean;
  env: Record<string, string | undefined>;
  nodeVersion?: string;
}): DoctorDiagnosis | null {
  const wantsE2e = args.tests.some((t) => t.runner === "playwright");
  const engines = args.setup.nodeVersion;
  if (engines && args.nodeVersion && /^[>^~]?=?\s*v?\d/.test(engines) && !satisfies(args.nodeVersion, engines)) {
    return {
      stage: "install",
      code: "wrong_runtime_version",
      message: `the repository wants Node ${engines} but the runner has ${args.nodeVersion}`,
      suggestedFix: { kind: "workflow_patch", instructions: `Add a setup-node step with node-version: ${engines.replace(/^[>^~=\s]+/, "")} before the DevAsign verify step.` },
    };
  }
  const missing = (args.yml?.env || []).filter((name) => !args.env[name]);
  if (missing.length) {
    return {
      stage: "services",
      code: "missing_secret",
      message: `${missing.length} environment variable(s) named in .devasign.yml are not set in this job: ${missing.join(", ")}`,
      missingSecrets: missing,
      suggestedFix: { kind: "workflow_patch", instructions: `Map each as env: NAME: \${{ secrets.NAME }} on the verify step, and add the secret in the repository settings.` },
    };
  }
  if (wantsE2e && !args.repoHasPlaywrightConfig && !(args.yml?.start && args.yml?.url)) {
    return {
      stage: "start",
      code: "no_start_command",
      message: "end-to-end tests were planned but nothing tells the runner how to start the app: no playwright.config webServer and no `verify.start`/`verify.url` in .devasign.yml",
      suggestedFix: { kind: "yml_patch", patch: "verify:\n  start: npm run dev\n  url: http://localhost:3000\n", instructions: "Add verify.start and verify.url to .devasign.yml (the command that serves the app and the URL it listens on)." },
    };
  }
  return null;
}

/** Turn a Playwright boot failure (from its output) into a diagnosis, or null. */
export function diagnosePlaywrightOutput(output: string): DoctorDiagnosis | null {
  if (/Executable doesn't exist|browserType\.launch: .*Executable/i.test(output)) {
    return { stage: "browsers", code: "browser_install_failed", message: "Playwright's Chromium is not installed on this runner", suggestedFix: { kind: "manual", instructions: "The runner installs Chromium automatically; if that failed, add `npx playwright install --with-deps chromium` to the workflow." } };
  }
  if (/Process from config\.webServer was not able to start|Error: Timed out waiting .* from config\.webServer|webServer.*exited/i.test(output)) {
    return { stage: "start", code: "app_not_ready", message: "the app did not become reachable at verify.url before the timeout", suggestedFix: { kind: "yml_patch", instructions: "Check verify.start and verify.url in .devasign.yml; make sure the start command serves that URL and needed env vars/services are provided." } };
  }
  if (/net::ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(output)) {
    return { stage: "start", code: "app_not_ready", message: "the browser could not connect to the app URL", suggestedFix: { kind: "yml_patch", instructions: "Set verify.start/verify.url in .devasign.yml so the runner boots the app before the tests." } };
  }
  return null;
}
