// Mint a GitHub-Actions-shaped OIDC token for a LOCAL run of @devasign/verify.
// Writes a keypair + JWKS under backend/.devasign-dev/ (gitignored) and prints
// the token plus the env the backend needs. Never usable against production:
// the backend ignores the issuer/JWKS overrides when production-like.
//   npx tsx scripts/verify-dev-token.ts --repo acme/widgets --repo-id 123 --pr 7 --sha <head-sha>
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "");
const need = (k: string) => {
  const v = args.get(k);
  if (!v) {
    console.error(`missing --${k}`);
    process.exit(1);
  }
  return v;
};
const repo = need("repo");
const repoId = need("repo-id");
const pr = need("pr");
const sha = need("sha");
const event = args.get("event") || "pull_request";
const audience = args.get("audience") || "devasign";
const issuer = args.get("issuer") || "https://devasign.local/oidc";
const dir = path.resolve(args.get("dir") || ".devasign-dev");
mkdirSync(dir, { recursive: true });
const pemPath = path.join(dir, "oidc-dev.pem");
let privateKey: string;
if (existsSync(pemPath)) privateKey = readFileSync(pemPath, "utf8");
else {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(pemPath, privateKey, { mode: 0o600 });
}
const jwk = createPublicKey(privateKey).export({ format: "jwk" });
const jwksPath = path.join(dir, "jwks.json");
writeFileSync(jwksPath, JSON.stringify({ keys: [{ ...jwk, kid: "dev-1", alg: "RS256", use: "sig" }] }, null, 2));
const token = jwt.sign(
  { repository: repo, repository_id: String(repoId), repository_owner: repo.split("/")[0], sha, ref: `refs/pull/${pr}/merge`, event_name: event, run_id: String(Date.now()), run_attempt: "1", actor: "dev", workflow: "local", sub: `repo:${repo}:pull_request` },
  privateKey,
  { algorithm: "RS256", keyid: "dev-1", expiresIn: args.get("ttl") || "2h", audience, issuer }
);
console.log(`# backend env (dev only):\nVERIFY_OIDC_ISSUER=${issuer}\nVERIFY_OIDC_JWKS_URL=file://${jwksPath}\n\n# runner:\nDEVASIGN_TOKEN=${token}`);
