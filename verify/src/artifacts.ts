// Sign, upload, and map clientRef → artifactId. Files go straight to the
// bucket via the signed PUT URL; the API never sees the bytes.
import { readFileSync, statSync } from "node:fs";
import type { ApiClient } from "./api.js";
import { log } from "./log.js";
import type { ArtifactSignFile, LocalArtifact, RunnerPlan, RunnerResult } from "./types.js";

const BATCH = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function planUploads(artifacts: LocalArtifact[], limits: RunnerPlan["uploadLimits"]): { files: ArtifactSignFile[]; skipped: Array<{ clientRef: string; reason: string }> } {
  const files: ArtifactSignFile[] = [];
  const skipped: Array<{ clientRef: string; reason: string }> = [];
  let total = 0;
  const seen = new Set<string>();
  // Evidence first: logs and test files before videos, so quota trims the big ones.
  const order = { log: 0, test_file: 1, screenshot: 2, poster: 3, trace: 4, video: 5 } as const;
  for (const a of [...artifacts].sort((x, y) => order[x.kind] - order[y.kind])) {
    if (seen.has(a.clientRef)) continue;
    seen.add(a.clientRef);
    let bytes: number;
    try {
      bytes = statSync(a.path).size;
    } catch {
      skipped.push({ clientRef: a.clientRef, reason: "missing" });
      continue;
    }
    if (bytes > limits.maxFileBytes) {
      skipped.push({ clientRef: a.clientRef, reason: "too_large" });
      continue;
    }
    if (files.length >= limits.maxFiles || total + bytes > limits.maxTotalBytes) {
      skipped.push({ clientRef: a.clientRef, reason: "quota" });
      continue;
    }
    total += bytes;
    files.push({ clientRef: a.clientRef, kind: a.kind, path: a.displayPath, bytes, contentType: a.contentType, testId: a.testId, criterionIds: a.criterionIds, attempt: a.attempt, posterFor: a.posterFor });
  }
  return { files, skipped };
}

export async function uploadArtifacts(api: ApiClient, runId: string, artifacts: LocalArtifact[], limits: RunnerPlan["uploadLimits"], fetchImpl: typeof fetch = fetch): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const { files, skipped } = planUploads(artifacts, limits);
  for (const s of skipped) log.warn(`artifact ${s.clientRef} not uploaded: ${s.reason}`);
  const byRef = new Map(artifacts.map((a) => [a.clientRef, a]));
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const signed = await api.signArtifacts(runId, batch);
    for (const r of signed.rejected || []) log.warn(`artifact ${r.clientRef} rejected by the API: ${r.reason}`);
    for (const u of signed.uploads || []) {
      const local = byRef.get(u.clientRef);
      if (!local) continue;
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const res = await fetchImpl(u.putUrl, { method: "PUT", headers: u.headers, body: readFileSync(local.path) });
          ok = res.ok;
          if (!ok) log.warn(`PUT ${local.displayPath} → HTTP ${res.status}`);
        } catch (err) {
          log.warn(`PUT ${local.displayPath} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!ok) await sleep(1_000 * (attempt + 1));
      }
      if (ok) ids.set(u.clientRef, u.artifactId);
    }
  }
  log.info(`uploaded ${ids.size}/${files.length} artifact(s)`);
  return ids;
}

/** Replace clientRefs in results with the uploaded artifact ids (dropping any that did not upload). */
export function resolveArtifactRefs(results: RunnerResult[], ids: Map<string, string>): RunnerResult[] {
  const map = (refs: string[]) => refs.map((r) => ids.get(r)).filter((id): id is string => !!id);
  return results.map((r) => ({
    ...r,
    artifactIds: map(r.artifactIds),
    attempts: r.attempts.map((a) => ({ ...a, artifactIds: map(a.artifactIds) })),
  }));
}
