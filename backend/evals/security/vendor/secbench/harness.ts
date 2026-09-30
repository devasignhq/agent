// Boots one fixture tree in-process and hands each case a client. Cases only
// ever reach the app through createApp, the production entry point's own wiring.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { signBody } from "./app-vulnerable/src/lib/hmac.ts";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export type Tree = "vulnerable" | "fixed";
export const TREE_DIR: Record<Tree, string> = { vulnerable: "app-vulnerable", fixed: "app-fixed" };

export const CANARY = "SECBENCH-CANARY-e3f19a";
export const PUBLIC_FILE = "SECBENCH-PUBLIC-FILE";
export const THUMB_FILE = "SECBENCH-THUMBNAIL";
const SECRET = "secbench-signing-secret";
const PUBLIC_IP = "93.184.216.34";

export type HttpResult = { status: number; text: string; json: any };

export type CaseCtx = {
  tree: Tree;
  tokens: { acmeMember: string; acmeAdmin: string; globexMember: string };
  canary: string;
  fetchCalls: string[];
  sign(body: string): string;
  credits(tenantId: string): number;
  get(route: string, token?: string): Promise<HttpResult>;
  post(route: string, body: unknown, opts?: { token?: string; signature?: string | null }): Promise<HttpResult>;
};

export type Booted = { ctx: CaseCtx; close(): Promise<void> };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

export async function bootTree(tree: Tree): Promise<Booted> {
  const dir = TREE_DIR[tree];
  const { createApp } = await import(`./${dir}/src/app.ts`);
  const { migrate, seed } = await import(`./${dir}/src/db/schema.ts`);

  const root = await mkdtemp(path.join(tmpdir(), `secbench-${tree}-`));
  const uploadsDir = path.join(root, "uploads");
  await mkdir(path.join(uploadsDir, "thumbnails"), { recursive: true });
  await writeFile(path.join(uploadsDir, "public.txt"), PUBLIC_FILE, "utf8");
  await writeFile(path.join(uploadsDir, "thumbnails", "thumb.txt"), THUMB_FILE, "utf8");
  // The file a traversal is trying to reach: outside uploadsDir, never served.
  await writeFile(path.join(root, "secret.txt"), CANARY, "utf8");

  const db = new DatabaseSync(":memory:");
  migrate(db);
  seed(db);

  const fetchCalls: string[] = [];
  const fetchImpl = (async (input: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    fetchCalls.push(url);
    return new Response("upstream body", { status: 200, headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;

  const app = createApp({
    db,
    uploadsDir,
    webhookSecret: SECRET,
    fetchImpl,
    lookup: async (hostname: string) => (hostname === "reports.example.com" ? PUBLIC_IP : "127.0.0.1"),
    allowedReportHosts: ["reports.example.com"],
    reportTimeoutMs: 2000,
  });

  const server = createServer(app);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  const read = async (res: Response): Promise<HttpResult> => {
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, text, json };
  };

  const ctx: CaseCtx = {
    tree,
    tokens: { acmeMember: "tok-acme-member", acmeAdmin: "tok-acme-admin", globexMember: "tok-globex-member" },
    canary: CANARY,
    fetchCalls,
    sign: (body) => signBody(SECRET, body),
    credits: (tenantId) =>
      (db.prepare("select credits_cents as c from tenants where id = ?").get(tenantId) as { c: number } | undefined)?.c ?? -1,
    async get(route, token) {
      return read(await fetch(`${base}${route}`, { headers: token ? { "x-api-token": token } : {} }));
    },
    async post(route, body, opts = {}) {
      const payload = JSON.stringify(body ?? {});
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.token) headers["x-api-token"] = opts.token;
      const signature = opts.signature === undefined ? signBody(SECRET, payload) : opts.signature;
      if (signature) headers["x-signature"] = signature;
      return read(await fetch(`${base}${route}`, { method: "POST", headers, body: payload }));
    },
  };

  return {
    ctx,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// Reachability: does the production entry point transitively import `target`?
export function isReachable(tree: Tree, entry: string, target: string): boolean {
  const treeRoot = path.join(HERE, TREE_DIR[tree]);
  const resolve = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const joined = path.resolve(path.dirname(from), spec);
    for (const candidate of [joined.replace(/\.js$/, ".ts"), joined, `${joined}.ts`, path.join(joined, "index.ts")]) {
      try {
        readFileSync(candidate, "utf8");
        return candidate;
      } catch {
        /* keep looking */
      }
    }
    return null;
  };
  const goal = path.join(treeRoot, target);
  const seen = new Set<string>();
  const queue = [path.join(treeRoot, entry)];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file === goal) return true;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const next = resolve(file, m[1]);
      if (next) queue.push(next);
    }
  }
  return false;
}
