// The runner's doctor diagnosis is stored, rendered into App-authored comments and turned
// into workflow commits, so only known fields with checked values get past the /v1 API.
import type { DoctorCode, DoctorDiagnosis, DoctorStage } from "./contract.js";
import { isKnownInstallCommand, PLAIN_DIR } from "./onboarding/generate.js";

const STAGES: Record<DoctorStage, true> = { checkout: true, install: true, build: true, services: true, start: true, browsers: true, tests: true };
const CODES: Record<DoctorCode, true> = {
  no_start_command: true,
  missing_service: true,
  missing_secret: true,
  wrong_runtime_version: true,
  install_failed: true,
  missing_dependencies: true,
  app_not_ready: true,
  browser_install_failed: true,
  unknown: true,
};
const FIX_KINDS = new Set(["yml_patch", "workflow_patch", "manual"]);
// An environment variable name: .devasign.yml may name lower-case ones too.
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
// The CLI's installCommandFor for the repository root carries no directory flag.
const ROOT_INSTALLS = new Set(["npm ci", "npm install", "pnpm install --frozen-lockfile", "yarn install --frozen-lockfile", "bun install"]);

// Well above anything the CLI writes (its messages list package and variable names); renderers clip further.
export const DOCTOR_LIMITS = { message: 2000, instructions: 2000, patch: 4000, secrets: 50, packages: 50 };

const knownPackage = (dir: string, install: string): boolean =>
  dir === "." ? ROOT_INSTALLS.has(install) : PLAIN_DIR.test(dir) && dir !== ".." && isKnownInstallCommand(install, dir);

const text = (v: unknown, cap: number): string => (typeof v === "string" ? v.slice(0, cap) : "");
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function normalizeDoctor(raw: unknown): DoctorDiagnosis | null {
  const o = record(raw);
  if (!o) return null;
  // An unrecognised stage reads as "tests": the last stage, which claims nothing about boot.
  const stage = typeof o.stage === "string" && Object.hasOwn(STAGES, o.stage) ? (o.stage as DoctorStage) : "tests";
  const code = typeof o.code === "string" && Object.hasOwn(CODES, o.code) ? (o.code as DoctorCode) : "unknown";
  const out: DoctorDiagnosis = { stage, code, message: text(o.message, DOCTOR_LIMITS.message) };

  if (Array.isArray(o.missingSecrets)) {
    out.missingSecrets = o.missingSecrets.filter((s): s is string => typeof s === "string" && SECRET_NAME.test(s)).slice(0, DOCTOR_LIMITS.secrets);
  }
  if (Array.isArray(o.packages)) {
    out.packages = o.packages
      .map(record)
      .filter((p): p is Record<string, unknown> => !!p && typeof p.dir === "string" && typeof p.install === "string")
      .filter((p) => knownPackage(p.dir as string, p.install as string))
      .slice(0, DOCTOR_LIMITS.packages)
      .map((p) => ({ dir: p.dir as string, install: p.install as string }));
  }
  if (typeof o.logArtifactId === "string" && o.logArtifactId) out.logArtifactId = o.logArtifactId.slice(0, 100);

  const fix = record(o.suggestedFix);
  if (fix) {
    const kind = typeof fix.kind === "string" && FIX_KINDS.has(fix.kind) ? (fix.kind as "yml_patch" | "workflow_patch" | "manual") : "manual";
    // A patch is shown inside a ``` fence; a backtick run of its own could close that fence.
    const patch = typeof fix.patch === "string" ? fix.patch.replace(/`{3,}/g, "~~~").slice(0, DOCTOR_LIMITS.patch) : "";
    out.suggestedFix = { kind, instructions: text(fix.instructions, DOCTOR_LIMITS.instructions), ...(patch ? { patch } : {}) };
  }
  return out;
}
