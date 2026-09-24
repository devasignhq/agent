// Pure half of import-render-env.mjs: which variables are secrets, which are skipped, and .env parsing.

export const SECRET_KEYS = new Set([
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

export const REQUIRED_KEYS = ["DATABASE_URL", "SESSION_SECRET", "INTEGRATION_ENCRYPTION_KEY", "WEB_ORIGIN", "GITHUB_APP_NAME"];

// PORT is reserved by Cloud Run; *_PATH point at files that only existed on the old host.
export const isSkipped = (key) =>
  key === "PORT" || key === "WEB_CONCURRENCY" || key.startsWith("RENDER") || key.endsWith("_PATH");

export function parseEnvText(text) {
  const vars = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    vars.set(m[1], value);
  }
  return vars;
}

export function classify(vars) {
  const out = { secrets: [], plain: [], skipped: [], empty: [], missing: [] };
  for (const [key, value] of [...vars].sort(([a], [b]) => a.localeCompare(b))) {
    if (isSkipped(key)) out.skipped.push(key);
    else if (value === "") out.empty.push(key);
    else if (SECRET_KEYS.has(key)) out.secrets.push(key);
    else out.plain.push(key);
  }
  out.missing = REQUIRED_KEYS.filter((k) => !out.secrets.includes(k) && !out.plain.includes(k));
  return out;
}
