// Wire contract with the DevAsign API (/v1). Mirrors backend/src/verify/contract.ts;
// additive changes only, kept in sync by hand.
import { createRequire } from "node:module";

// Substituted from package.json at build time (scripts/build.mjs), which folds this
// to a literal and drops the tsx-only fallback below. Hand-maintaining it drifted once.
declare const __CLI_VERSION__: string | undefined;
// The commit scripts/build.mjs bundled from (-dirty if uncommitted); null under tsx or outside git.
declare const __CLI_COMMIT__: string | null | undefined;

function manifestVersion(): string {
  return createRequire(import.meta.url)("../package.json").version;
}

export const CLI_VERSION: string = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : manifestVersion();
export const CLI_COMMIT: string | null = typeof __CLI_COMMIT__ === "string" ? __CLI_COMMIT__ : null;
export const API_VERSION = 1;

export type TestLevel = "unit" | "integration" | "component" | "e2e";
export type TestRunner = "vitest" | "jest" | "pytest" | "playwright" | "go" | "node-test" | "bundled";
export type TestOrigin = "existing" | "generated";
export type CriterionKind = "code" | "ui" | "unverifiable";

export type PlanTest = {
  id: string;
  path: string;
  content: string | null;
  criterionIds: string[];
  level: TestLevel;
  levelReason: string;
  origin: TestOrigin;
  runner: TestRunner;
  testSignature: string;
  strategyVersion: number;
  targetFiles: string[];
};

export type PlanCommand = {
  id: string;
  runner: TestRunner;
  cmd: string;
  cwd?: string;
  testIds: string[];
  timeoutMs: number;
  needsBrowsers?: boolean;
};

export type DetectedFramework = {
  name: "vitest" | "jest" | "pytest" | "playwright" | "cypress" | "go-test" | "node-test";
  version?: string;
  configPath?: string;
};

export type DetectedSetup = {
  languages: string[];
  packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "go" | null;
  monorepo?: { tool: "pnpm" | "turbo" | "nx" | "workspaces" | null; packages: string[] } | null;
  frameworks: DetectedFramework[];
  // Declared package names (dependencies + devDependencies). Absent on rows stored
  // before this field existed, so read it as `?? []`.
  dependencies?: string[];
  // Top-level directories that carry their own package.json when the root has none
  // ("backend", "frontend"). Each installs and resolves its own dependencies.
  packages?: string[];
  testCommands: string[];
  envExampleVars: string[];
  existingWorkflows: string[];
  nodeVersion?: string;
  pythonVersion?: string;
  services: Array<"postgres" | "mysql" | "redis">;
};

export type DoctorStage = "checkout" | "install" | "build" | "services" | "start" | "login" | "browsers" | "tests";
export type DoctorCode =
  | "no_start_command"
  | "login_failed"
  | "missing_service"
  | "missing_secret"
  | "wrong_runtime_version"
  | "install_failed"
  | "missing_dependencies"
  | "app_not_ready"
  | "browser_install_failed"
  | "unknown";

export type DoctorDiagnosis = {
  stage: DoctorStage;
  code: DoctorCode;
  message: string;
  missingSecrets?: string[];
  logArtifactId?: string;
  // missing_dependencies: the package directories whose node_modules were absent,
  // each with the install command the workflow needs before the verify step.
  packages?: Array<{ dir: string; install: string }>;
  suggestedFix?: { kind: "yml_patch" | "workflow_patch" | "manual"; patch?: string; instructions: string };
};

export type DevasignVerifyConfig = {
  e2e?: "auto" | "always" | "never";
  install?: string;
  build?: string;
  start?: string;
  url?: string;
  ready?: string;
  seed?: string;
  // Seconds each step of a managed boot (servers or a login script) may take.
  timeout?: number;
  // Started in order before `start`; `start`/`url` stay the app the browser opens.
  servers?: Array<{ name: string; start: string; url: string; ready?: string }>;
  services?: Array<{ name: "postgres" | "mysql" | "redis"; image?: string; env?: Record<string, string> }>;
  login?: {
    // Writes a Playwright storageState JSON to $DEVASIGN_STORAGE_STATE; generated browser tests start with it.
    script?: string;
    // A path on `url`, or an absolute URL, that must answer 2xx with that session.
    check?: string;
    // Legacy strategies: parsed, but nothing applies them.
    strategy?: "none" | "storage_state" | "form" | "cookie";
    storageState?: string;
    form?: { url: string; user: string; pass: string; submit?: string };
  };
  env?: string[];
};

export type RunnerCapability = "managed_boot" | "boot_probe";

export type ResolveEvent = "pull_request" | "repository_dispatch" | "workflow_dispatch";

export type ResolveRequest = {
  sha: string;
  pr: number;
  event?: ResolveEvent;
  attempt?: number;
  setup?: DetectedSetup;
  actions?: { runId: string; jobUrl?: string; runnerOs?: string };
  cliVersion?: string;
  giveUp?: boolean;
  capabilities?: RunnerCapability[];
};

export type RunnerPlan = {
  planId: string;
  criteriaRevision: number;
  criteria: Array<{ id: string; text: string; kind: CriterionKind }>;
  tests: PlanTest[];
  commands: PlanCommand[];
  playwright: { record: true; configFrom: string | null; installBrowsers: boolean } | null;
  retries: { generated: number; existing: number };
  uploadLimits: { maxFileBytes: number; maxTotalBytes: number; maxFiles: number };
  // Optional: servers older than 1.2 send neither.
  unverifiable?: Array<{ criterionId: string; reason: string; fixUrl?: string }>;
  failOn?: FailOn;
  // The base branch's verify block, for a checkout cut before onboarding that has none.
  verifyConfig?: DevasignVerifyConfig;
  // false: the backend switched managed boot off, so keep Playwright's webServer. Absent: the yml decides.
  managedBoot?: boolean;
};

export type FailOn = "never" | "verdict" | "unverifiable";

export type ResolveResponse =
  | { ok: true; status: "pending"; runId: string | null; retryAfterMs: number; giveUpAfterMs?: number }
  | { ok: true; status: "ready"; runId: string; plan: RunnerPlan }
  | { ok: true; status: "empty"; runId: string | null; reason: string }
  | { ok: true; status: "setup"; runId: string; onboardingPr?: number };

export type ArtifactKind = "video" | "trace" | "screenshot" | "log" | "test_file" | "poster";

export type ArtifactSignFile = {
  clientRef: string;
  kind: ArtifactKind;
  path: string;
  bytes: number;
  contentType: string;
  testId?: string;
  criterionIds?: string[];
  attempt?: number;
  posterFor?: string;
};

export type ArtifactSignResponse = {
  ok: true;
  uploads: Array<{ clientRef: string; artifactId: string; putUrl: string; headers: Record<string, string>; urlExpiresAt: number; retentionExpiresAt: number }>;
  rejected: Array<{ clientRef: string; reason: string }>;
};

export type ResultStatus = "pass" | "fail" | "flaky" | "error" | "skipped";
export type AttemptStatus = "pass" | "fail" | "error";

export type RunnerAttempt = { n: number; status: AttemptStatus; durationMs: number; error?: string; artifactIds: string[] };

export type RunnerResult = {
  id: string;
  testId: string;
  criterionIds: string[];
  test: string;
  runner: TestRunner;
  level: TestLevel;
  origin: TestOrigin;
  status: ResultStatus;
  attempts: RunnerAttempt[];
  durationMs: number;
  error?: string;
  artifactIds: string[];
};

export type RunnerResults = {
  runId: string;
  sha: string;
  planId: string | null;
  cliVersion: string;
  results: RunnerResult[];
  existingTestsTouchingDiff: string[];
  stdoutArtifactId?: string;
  setup?: DetectedSetup;
  doctor?: DoctorDiagnosis | null;
  timings: { startedAt: number; installFinishedAt?: number; finishedAt: number };
};

export type RunView = {
  ok: true;
  run: { id: string; status: string; verdicts: Array<{ criterionId: string; verdict: "pass" | "fail" | "unverifiable"; reason: string; fixUrl?: string }> };
  terminal: boolean;
  runUrl?: string;
};

// A file on disk that will become an artifact once signed and uploaded.
export type LocalArtifact = {
  clientRef: string;
  kind: ArtifactKind;
  path: string; // absolute
  displayPath: string; // repo-relative, what the API stores
  contentType: string;
  testId?: string;
  criterionIds: string[];
  attempt?: number;
  posterFor?: string;
};
