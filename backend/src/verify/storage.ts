// Private object storage for run artifacts (S3 API; Cloudflare R2 in prod).
// Bytes never pass through this server: the runner PUTs to a signed URL and the
// app GETs from a short-lived signed URL. Rows in verifyArtifacts hold only keys.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config, isArtifactStorageConfigured } from "../config.js";
import type { Plan } from "../billing/plans.js";
import type { VerifyArtifactKind } from "../types.js";

export type ArtifactStorage = {
  signPut(key: string, contentType: string, ttlSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
  signGet(key: string, ttlSeconds: number): Promise<string>;
  head(key: string): Promise<{ bytes: number } | null>;
  remove(key: string): Promise<void>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS: Record<Plan, number> = { free: 1 * DAY_MS, pro: 3 * DAY_MS, max: 3 * DAY_MS };

export function retentionExpiresAt(plan: Plan, now: number = Date.now()): number {
  return now + RETENTION_MS[plan];
}

export const UPLOAD_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFiles: 200,
} as const;

const EXT: Record<VerifyArtifactKind, string> = {
  video: "webm",
  trace: "zip",
  screenshot: "png",
  log: "txt",
  test_file: "txt",
  poster: "jpg",
};

export function artifactKey(repoId: string, runId: string, artifactId: string, kind: VerifyArtifactKind, contentType: string): string {
  let ext = EXT[kind];
  if (kind === "screenshot" && /jpe?g/i.test(contentType)) ext = "jpg";
  return `${repoId}/${runId}/${artifactId}.${ext}`;
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: config.artifacts.region,
      endpoint: config.artifacts.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.artifacts.accessKeyId,
        secretAccessKey: config.artifacts.secretAccessKey,
      },
    });
  }
  return client;
}

const s3Storage: ArtifactStorage = {
  async signPut(key, contentType, ttlSeconds) {
    const url = await getSignedUrl(
      s3(),
      new PutObjectCommand({ Bucket: config.artifacts.bucket, Key: key, ContentType: contentType }),
      { expiresIn: ttlSeconds }
    );
    return { url, headers: { "Content-Type": contentType } };
  },
  async signGet(key, ttlSeconds) {
    return getSignedUrl(s3(), new GetObjectCommand({ Bucket: config.artifacts.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  },
  async head(key) {
    try {
      const out = await s3().send(new HeadObjectCommand({ Bucket: config.artifacts.bucket, Key: key }));
      return { bytes: Number(out.ContentLength ?? 0) };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "NotFound" || name === "NoSuchKey") return null;
      throw err;
    }
  },
  async remove(key) {
    await s3().send(new DeleteObjectCommand({ Bucket: config.artifacts.bucket, Key: key }));
  },
};

let override: ArtifactStorage | null | undefined;

/** The configured storage, or null when ARTIFACT_S3_* is unset (artifacts disabled). */
export function artifactStorage(): ArtifactStorage | null {
  if (override !== undefined) return override;
  return isArtifactStorageConfigured() ? s3Storage : null;
}

export function setArtifactStorageForTests(s: ArtifactStorage | null | undefined): void {
  override = s;
}
