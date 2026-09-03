// The `verify:` block of .devasign.yml. Everything else in the file is ignored
// here (cross-repo/topology.ts reads `family:` with its own minimal scanner).
import { parse } from "yaml";
import type { DevasignVerifyConfig } from "./contract.js";

const SERVICES = new Set(["postgres", "mysql", "redis"]);
const LOGIN = new Set(["none", "storage_state", "form", "cookie"]);

const str = (v: unknown, cap = 500): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : undefined;

export function parseDevasignVerify(raw: string | null | undefined): DevasignVerifyConfig | null {
  if (!raw || !raw.trim()) return null;
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch {
    return null;
  }
  const v = (doc as { verify?: unknown } | null)?.verify;
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out: DevasignVerifyConfig = {};
  if (o.e2e === "auto" || o.e2e === "always" || o.e2e === "never") out.e2e = o.e2e;
  for (const k of ["install", "build", "start", "url", "ready", "seed"] as const) {
    const s = str(o[k]);
    if (s) out[k] = s;
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
    if (LOGIN.has(String(l.strategy))) {
      out.login = { strategy: String(l.strategy) as NonNullable<DevasignVerifyConfig["login"]>["strategy"] };
      if (str(l.storageState)) out.login.storageState = str(l.storageState);
      if (l.form && typeof l.form === "object") {
        const f = l.form as Record<string, unknown>;
        if (str(f.url) && str(f.user) && str(f.pass)) {
          out.login.form = { url: str(f.url)!, user: str(f.user)!, pass: str(f.pass)!, ...(str(f.submit) ? { submit: str(f.submit) } : {}) };
        }
      }
    }
  }
  if (Array.isArray(o.env)) out.env = o.env.filter((e) => typeof e === "string").map(String).slice(0, 100);
  return out;
}

/** Boot config the runner can start the app from — a precondition for planning any E2E test. */
export function hasBootConfig(cfg: DevasignVerifyConfig | null | undefined): boolean {
  return Boolean(cfg?.start && cfg?.url);
}
