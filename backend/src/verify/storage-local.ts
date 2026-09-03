// Dev-only artifact store: files on local disk behind HMAC-signed PUT/GET URLs
// that this server serves (routes/v1.ts). Refused when production-like — prod
// artifacts never pass through the API server (R2 presigned URLs do that).
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config, isProductionLike } from "../config.js";
import type { ArtifactStorage } from "./storage.js";

export const LOCAL_ROUTE = "/v1/artifacts/local";

export function localStoreEnabled(): boolean {
  return Boolean(config.artifacts.localDir) && !isProductionLike();
}

export function localArtifactPath(key: string): string | null {
  const root = path.resolve(config.artifacts.localDir);
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep) || key.includes("..")) return null;
  return full;
}

function sign(method: string, key: string, exp: number): string {
  return createHmac("sha256", config.sessionSecret).update(`${method}\n${key}\n${exp}`).digest("hex");
}

export function verifyLocalSignature(method: string, key: string, exp: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp < now) return false;
  const expected = sign(method, key, exp);
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function url(method: "PUT" | "GET", key: string, ttlSeconds: number): string {
  const exp = Date.now() + ttlSeconds * 1000;
  const base = config.artifacts.apiOrigin.replace(/\/+$/, "");
  return `${base}${LOCAL_ROUTE}/${encodeURIComponent(key)}?exp=${exp}&sig=${sign(method, key, exp)}`;
}

export function localArtifactStorage(): ArtifactStorage | null {
  if (!localStoreEnabled()) return null;
  return {
    async signPut(key, contentType, ttlSeconds) {
      const full = localArtifactPath(key);
      if (full) await mkdir(path.dirname(full), { recursive: true });
      return { url: url("PUT", key, ttlSeconds), headers: { "Content-Type": contentType } };
    },
    async signGet(key, ttlSeconds) {
      return url("GET", key, ttlSeconds);
    },
    async head(key) {
      const full = localArtifactPath(key);
      if (!full) return null;
      try {
        return { bytes: (await stat(full)).size };
      } catch {
        return null;
      }
    },
    async remove(key) {
      const full = localArtifactPath(key);
      if (!full) return;
      await unlink(full).catch(() => {});
    },
  };
}
