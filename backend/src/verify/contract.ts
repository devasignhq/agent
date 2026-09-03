// Wire contract between the @devasign/verify runner and the /v1 API. Other
// people's CI depends on these shapes: additive changes only; breaking → v2.
import type {
  Criterion,
  CriterionKind,
  VerifyArtifact,
  VerifyArtifactKind,
  VerifyPlan,
  VerifyRun,
} from "../types.js";

export const VERIFY_API_VERSION = 1;
export const OIDC_AUDIENCE_DEFAULT = "devasign";

export type TestLevel = "unit" | "integration" | "component" | "e2e";
export type TestRunner = "vitest" | "jest" | "pytest" | "playwright" | "go" | "node-test" | "bundled";
export type TestOrigin = "existing" | "generated";

export type PlanTest = {
  id: string;
  path: string;
  content: string | null; // null when origin = existing
  criterionIds: string[];
  level: TestLevel;
  levelReason: string;
  origin: TestOrigin;
  runner: TestRunner;
  testSignature: string; // sha256(criterion text + level + target files)
  strategyVersion: number; // bumps each time a flaky signature is regenerated
  targetFiles: string[]; // repo files the test exercises (part of the signature)
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

// The `verify:` block of .devasign.yml. Unknown keys are ignored.
export type DevasignVerifyConfig = {
  e2e?: "auto" | "always" | "never";
  install?: string;
  build?: string;
  start?: string;
  url?: string;
  ready?: string;
  seed?: string;
  services?: Array<{ name: "postgres" | "mysql" | "redis"; image?: string; env?: Record<string, string> }>;
  login?: {
    strategy: "none" | "storage_state" | "form" | "cookie";
    storageState?: string;
    form?: { url: string; user: string; pass: string; submit?: string };
  };
  env?: string[];
};

// ---- POST /v1/runs/resolve ------------------------------------------------

export type ResolveEvent = "pull_request" | "repository_dispatch" | "workflow_dispatch";

export type ResolveRequest = {
  sha: string; // PR head sha (NOT the merge-ref sha the OIDC token carries)
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

export type ResolveEmptyReason =
  | "no_criteria"
  | "verify_disabled"
  | "storage_unconfigured"
  | "superseded"
  | "already_completed";

export type ResolveResponse =
  | { ok: true; status: "pending"; runId: string | null; retryAfterMs: number }
  | { ok: true; status: "ready"; runId: string; plan: RunnerPlan }
  | { ok: true; status: "empty"; runId: string | null; reason: ResolveEmptyReason }
  | { ok: true; status: "setup"; runId: string; onboardingPr?: number };

// ---- POST /v1/runs/{runId}/artifacts ----------------------------------------

export type ArtifactSignFile = {
  clientRef: string;
  kind: VerifyArtifactKind;
  path: string;
  bytes: number;
  contentType: string;
  testId?: string;
  criterionIds?: string[];
  attempt?: number;
  posterFor?: string; // clientRef of the video this poster belongs to
};

export type ArtifactSignRequest = { files: ArtifactSignFile[] };

export type ArtifactRejectReason = "too_large" | "quota" | "unsupported_kind" | "storage_unconfigured" | "invalid";

export type ArtifactSignResponse = {
  ok: true;
  uploads: Array<{
    clientRef: string;
    artifactId: string;
    putUrl: string;
    headers: Record<string, string>;
    urlExpiresAt: number;
    retentionExpiresAt: number;
  }>;
  rejected: Array<{ clientRef: string; reason: ArtifactRejectReason }>;
};

// ---- POST /v1/runs/{runId}/results -----------------------------------------

export type ResultStatus = "pass" | "fail" | "flaky" | "error" | "skipped";
export type AttemptStatus = "pass" | "fail" | "error";

export type RunnerAttempt = {
  n: number;
  status: AttemptStatus;
  durationMs: number;
  error?: string;
  artifactIds: string[];
};

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

export type ResultsResponse = { ok: true; runId: string; status: "judging" };

// ---- GET /v1/runs/{runId} ---------------------------------------------------

export type RunViewArtifact = Pick<
  VerifyArtifact,
  "id" | "kind" | "testId" | "criterionIds" | "bytes" | "state" | "expiresAt" | "posterArtifactId" | "path" | "attempt"
> & { getUrl: string | null; posterUrl: string | null; urlExpiresAt: number | null };

export type RunView = {
  run: Omit<VerifyRun, "tokenUsage"> & { tokenUsage?: VerifyRun["tokenUsage"] };
  criteria: Criterion[];
  revision: number;
  plan: (Omit<VerifyPlan, "tests"> & { tests: Array<Omit<PlanTest, "content">> }) | null;
  results: RunnerResult[] | null;
  artifacts: RunViewArtifact[];
  report: { checkRunUrl?: string; commentUrl?: string };
};

export type ApiError = { ok: false; error: string; retryAfterMs?: number; detail?: string };
