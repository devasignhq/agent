// Wire contract with the DevAsign API (/v1). Mirrors backend/src/verify/contract.ts;
// additive changes only, kept in sync by hand.
export const CLI_VERSION = "1.0.1";
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
  testCommands: string[];
  envExampleVars: string[];
  existingWorkflows: string[];
  nodeVersion?: string;
  pythonVersion?: string;
  services: Array<"postgres" | "mysql" | "redis">;
};

export type DoctorStage = "checkout" | "install" | "build" | "services" | "start" | "browsers" | "tests";
export type DoctorCode =
  | "no_start_command"
  | "missing_service"
  | "missing_secret"
  | "wrong_runtime_version"
  | "install_failed"
  | "app_not_ready"
  | "browser_install_failed"
  | "unknown";

export type DoctorDiagnosis = {
  stage: DoctorStage;
  code: DoctorCode;
  message: string;
  missingSecrets?: string[];
  logArtifactId?: string;
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
  services?: Array<{ name: "postgres" | "mysql" | "redis"; image?: string; env?: Record<string, string> }>;
  login?: { strategy: "none" | "storage_state" | "form" | "cookie"; storageState?: string; form?: { url: string; user: string; pass: string; submit?: string } };
  env?: string[];
};

export type ResolveEvent = "pull_request" | "repository_dispatch" | "workflow_dispatch";

export type ResolveRequest = {
  sha: string;
  pr: number;
  event?: ResolveEvent;
  attempt?: number;
  setup?: DetectedSetup;
  actions?: { runId: string; jobUrl?: string; runnerOs?: string };
  cliVersion?: string;
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
};

export type ResolveResponse =
  | { ok: true; status: "pending"; runId: string | null; retryAfterMs: number }
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
  run: { id: string; status: string; verdicts: Array<{ criterionId: string; verdict: "pass" | "fail" | "unverifiable"; reason: string }> };
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
