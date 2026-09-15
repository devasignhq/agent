// The `verify:` block of .devasign.yml, normalized the same way the backend's
// normalizeVerifyBlock does (backend/src/verify/yml.ts); keep the two in step.
import type { DevasignVerifyConfig } from "./types.js";

const SERVICES = new Set(["postgres", "mysql", "redis"]);
const LOGIN = new Set(["none", "storage_state", "form", "cookie"]);
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Step names the boot already uses for its own logs and diagnoses.
export const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set(["app", "install", "build", "seed", "login"]);
export const MAX_SERVERS = 4;
export const BOOT_TIMEOUT = { min: 10, max: 900, default: 180 };

// The keys that say how the app boots; they travel as one group when a plan's block fills in the checkout's.
export const BOOT_KEYS = ["install", "build", "seed", "start", "url", "ready", "timeout", "servers", "login"] as const;

const str = (v: unknown, cap = 500): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : undefined;

// The checkout's commands run exactly as merged, never cut short (the backend drops over-long ones).
const command = (v: unknown): string | undefined => str(v, Infinity);

export function normalizeVerify(v: unknown): DevasignVerifyConfig | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: DevasignVerifyConfig = {};
  if (o.e2e === "auto" || o.e2e === "always" || o.e2e === "never") out.e2e = o.e2e;
  for (const k of ["install", "build", "start", "url", "ready", "seed"] as const) {
    const s = command(o[k]);
    if (s) out[k] = s;
  }
  if (Number.isInteger(o.timeout)) out.timeout = Math.min(BOOT_TIMEOUT.max, Math.max(BOOT_TIMEOUT.min, o.timeout as number));
  if (Array.isArray(o.servers)) {
    const seen = new Set<string>();
    const servers = o.servers
      .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {}))
      .flatMap((s) => {
        const name = str(s.name, Infinity);
        const start = command(s.start);
        const url = command(s.url);
        if (!name || !SERVER_NAME.test(name) || RESERVED_SERVER_NAMES.has(name) || seen.has(name) || !start || !url) return [];
        seen.add(name);
        const ready = command(s.ready);
        return [{ name, start, url, ...(ready ? { ready } : {}) }];
      })
      .slice(0, MAX_SERVERS);
    if (servers.length) out.servers = servers;
  }
  if (Array.isArray(o.services)) {
    out.services = o.services
      .map((s) => (typeof s === "string" ? { name: s } : (s as Record<string, unknown>)))
      .filter((s) => s && SERVICES.has(String(s.name)))
      .map((s) => ({
        name: String(s.name) as "postgres" | "mysql" | "redis",
        ...(str(s.image) ? { image: str(s.image) } : {}),
        ...(s.env && typeof s.env === "object"
          ? { env: Object.fromEntries(Object.entries(s.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) }
          : {}),
      }));
  }
  if (o.login && typeof o.login === "object") {
    const l = o.login as Record<string, unknown>;
    const login: NonNullable<DevasignVerifyConfig["login"]> = {};
    const script = command(l.script);
    const check = command(l.check);
    if (script) login.script = script;
    if (check) login.check = check;
    if (LOGIN.has(String(l.strategy))) {
      login.strategy = String(l.strategy) as NonNullable<DevasignVerifyConfig["login"]>["strategy"];
      if (str(l.storageState)) login.storageState = str(l.storageState);
      if (l.form && typeof l.form === "object") {
        const f = l.form as Record<string, unknown>;
        if (str(f.url) && str(f.user) && str(f.pass)) {
          login.form = { url: str(f.url)!, user: str(f.user)!, pass: str(f.pass)!, ...(str(f.submit) ? { submit: str(f.submit) } : {}) };
        }
      }
    }
    if (Object.keys(login).length) out.login = login;
  }
  if (Array.isArray(o.env)) out.env = o.env.filter((e) => typeof e === "string").map(String).slice(0, 100);
  return out;
}

// A checkout block without `start` keeps its other keys but boots the way the plan's block
// does, the same rule the backend planned by (readVerifyYml).
export function mergeBootConfig(checkout: DevasignVerifyConfig | null, planCfg: DevasignVerifyConfig | null | undefined): DevasignVerifyConfig | null {
  if (!checkout) return planCfg ?? null;
  if (checkout.start || !planCfg?.start) return checkout;
  const boot: ReadonlySet<string> = new Set(BOOT_KEYS);
  return {
    ...Object.fromEntries(Object.entries(checkout).filter(([k]) => !boot.has(k))),
    ...Object.fromEntries(Object.entries(planCfg).filter(([k]) => boot.has(k))),
  } as DevasignVerifyConfig;
}

/** Servers or a login script need the runner's own boot manager rather than Playwright's webServer. */
export function needsManagedBoot(cfg: DevasignVerifyConfig | null | undefined): boolean {
  return Boolean(cfg?.servers?.length || cfg?.login?.script);
}
