#!/usr/bin/env node
// Copies the Render service's env into GCP: secrets → Secret Manager, the rest → a Cloud Run env-vars YAML.
// Values go Render API → gcloud stdin only; they are never printed, logged, or passed on argv.
//
//   RENDER_API_KEY=… node backend/deploy/gcp/import-render-env.mjs --render-service srv-…        (preview)
//   RENDER_API_KEY=… node backend/deploy/gcp/import-render-env.mjs --render-service srv-… --apply
//   node backend/deploy/gcp/import-render-env.mjs --from-file path/to/prod.env --apply           (no Render API)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "render-service": { type: "string" },
    "from-file": { type: "string" },
    project: { type: "string", default: "resounding-sled-478814-m2" },
    "service-account": { type: "string", default: "devasign-api" },
    apply: { type: "boolean", default: false },
  },
});

const SECRET_KEYS = new Set([
  "DATABASE_URL",
  "SESSION_SECRET",
  "SESSION_SECRET_PREVIOUS",
  "INTEGRATION_ENCRYPTION_KEY",
  "ADMIN_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "STELLAR_ADMIN_SECRET",
  "ARTIFACT_S3_ACCESS_KEY_ID",
  "ARTIFACT_S3_SECRET_ACCESS_KEY",
  "LINEAR_API_KEY",
  "LINEAR_OAUTH_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "STATSIG_SECRET_KEY",
]);

// PORT is reserved by Cloud Run; *_PATH point at files that only existed on the old host.
const SKIP = (key) =>
  key === "PORT" || key === "WEB_CONCURRENCY" || key.startsWith("RENDER") || key.endsWith("_PATH");

const outDir = path.dirname(fileURLToPath(import.meta.url));
const envYamlPath = path.join(outDir, ".env.cloudrun.yaml");
const secretsSpecPath = path.join(outDir, ".env.cloudrun.secrets");
const gcloud = process.env.GCLOUD || path.join(homedir(), "google-cloud-sdk/bin/gcloud");

async function fromRender(serviceId) {
  const token = process.env.RENDER_API_KEY;
  if (!token) throw new Error("RENDER_API_KEY is not set");
  const vars = new Map();
  let cursor = "";
  for (;;) {
    const url = `https://api.render.com/v1/services/${serviceId}/env-vars?limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Render API ${res.status} for ${serviceId}`);
    const page = await res.json();
    for (const { envVar } of page) vars.set(envVar.key, envVar.value ?? "");
    if (page.length < 100) return vars;
    cursor = encodeURIComponent(page[page.length - 1].cursor);
  }
}

function fromFile(file) {
  const vars = new Map();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    vars.set(m[1], value);
  }
  return vars;
}

function run(argv, input) {
  const r = spawnSync(gcloud, [...argv, `--project=${args.project}`, "--quiet"], {
    input,
    encoding: "utf8",
  });
  return { ok: r.status === 0, err: (r.stderr || "").trim() };
}

function putSecret(key, value, member) {
  const exists = run(["secrets", "describe", key, "--format=value(name)"]).ok;
  const write = exists
    ? run(["secrets", "versions", "add", key, "--data-file=-"], value)
    : run(["secrets", "create", key, "--replication-policy=automatic", "--data-file=-"], value);
  if (!write.ok) throw new Error(`secret ${key}: ${write.err}`);
  const grant = run([
    "secrets", "add-iam-policy-binding", key,
    `--member=${member}`, "--role=roles/secretmanager.secretAccessor", "--format=none",
  ]);
  if (!grant.ok) throw new Error(`grant ${key}: ${grant.err}`);
  return exists ? "new version" : "created";
}

const vars = args["from-file"]
  ? fromFile(args["from-file"])
  : args["render-service"]
    ? await fromRender(args["render-service"])
    : (() => { throw new Error("pass --render-service srv-… or --from-file <path>"); })();

const secrets = [], plain = [], skipped = [], empty = [];
for (const [key, value] of [...vars].sort(([a], [b]) => a.localeCompare(b))) {
  if (SKIP(key)) skipped.push(key);
  else if (value === "") empty.push(key);
  else if (SECRET_KEYS.has(key)) secrets.push(key);
  else plain.push(key);
}

console.log(`Read ${vars.size} variables.`);
console.log(`  Secret Manager (${secrets.length}): ${secrets.join(" ") || "-"}`);
console.log(`  Plain env      (${plain.length}): ${plain.join(" ") || "-"}`);
console.log(`  Skipped        (${skipped.length}): ${skipped.join(" ") || "-"}`);
if (empty.length) console.log(`  Empty, ignored (${empty.length}): ${empty.join(" ")}`);
const missing = ["DATABASE_URL", "SESSION_SECRET", "INTEGRATION_ENCRYPTION_KEY", "WEB_ORIGIN", "GITHUB_APP_NAME"]
  .filter((k) => !secrets.includes(k) && !plain.includes(k));
if (missing.length) console.log(`  WARNING — required in prod but absent: ${missing.join(" ")}`);

if (!args.apply) {
  console.log("\nPreview only. Re-run with --apply to write to GCP.");
  process.exit(0);
}

const member = `serviceAccount:${args["service-account"]}@${args.project}.iam.gserviceaccount.com`;
for (const key of secrets) console.log(`  ${key}: ${putSecret(key, vars.get(key), member)}`);

writeFileSync(envYamlPath, plain.map((k) => `${k}: ${JSON.stringify(vars.get(k))}\n`).join(""), { mode: 0o600 });
writeFileSync(secretsSpecPath, secrets.map((k) => `${k}=${k}:latest`).join(",") + "\n");
console.log(`\nWrote ${path.relative(process.cwd(), envYamlPath)} (plain env, gitignored)`);
console.log(`Wrote ${path.relative(process.cwd(), secretsSpecPath)} (--set-secrets spec, names only)`);
