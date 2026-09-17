// The setup PR's own CI is the only evidence for the config that PR proposes, and an empty
// commit is what re-runs it. What must hold: the SAME tree (an empty commit that rewrites
// the tree would silently edit the maintainer's branch) and force: false. Stubs GitHub the
// way comment-trigger-cap.test.ts does. Run:
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/github/app.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { config } from "../config.js";
import { pushEmptyCommit } from "./app.js";

// appJWT() refuses to sign unless the App is "configured", so mint a throwaway key.
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
config.github.appId = "123456";
config.github.privateKey = privateKey as string;

type Call = { url: string; method: string; body: any };

function stubGitHub(routes: (url: string, method: string, body: any) => Response | null) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (u.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: `tok-${Math.random()}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }
    calls.push({ url: u, method, body });
    const res = routes(u, method, body);
    if (!res) throw new Error(`unexpected fetch in test: ${method} ${u}`);
    return res;
  }) as any;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let inst = 0;
const nextInstallation = () => 77000 + inst++;

test("an empty commit reuses the head's tree and updates the ref without force", async () => {
  const calls = stubGitHub((u, method) => {
    if (u.endsWith("/git/ref/heads/devasign/enable-verification") && method === "GET") {
      return json({ object: { sha: "parent111" } });
    }
    if (u.endsWith("/git/commits/parent111") && method === "GET") {
      return json({ sha: "parent111", tree: { sha: "tree999" } });
    }
    if (u.endsWith("/git/commits") && method === "POST") return json({ sha: "newsha222" }, 201);
    if (u.endsWith("/git/refs/heads/devasign/enable-verification") && method === "PATCH") {
      return json({ object: { sha: "newsha222" } });
    }
    return null;
  });

  const sha = await pushEmptyCommit(nextInstallation(), "acme", "web", "devasign/enable-verification", "devasign: re-run setup checks");
  assert.equal(sha, "newsha222");

  const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"));
  assert.ok(created, "it creates a commit object");
  assert.equal(created!.body.tree, "tree999", "the same tree — an empty commit changes no file");
  assert.deepEqual(created!.body.parents, ["parent111"]);
  assert.equal(created!.body.message, "devasign: re-run setup checks");

  const patched = calls.find((c) => c.method === "PATCH");
  assert.ok(patched, "it moves the ref");
  assert.equal(patched!.body.sha, "newsha222");
  assert.notEqual(patched!.body.force, true, "never a force-push");
  // Only the named branch is touched, and its slash stays literal.
  assert.ok(patched!.url.endsWith("/repos/acme/web/git/refs/heads/devasign/enable-verification"), patched!.url);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
});

test("a ref update GitHub rejects returns null, and no other branch is touched", async () => {
  const calls = stubGitHub((u, method) => {
    if (u.endsWith("/git/ref/heads/setup") && method === "GET") return json({ object: { sha: "p1" } });
    if (u.endsWith("/git/commits/p1") && method === "GET") return json({ tree: { sha: "t1" } });
    if (u.endsWith("/git/commits") && method === "POST") return json({ sha: "c1" }, 201);
    if (method === "PATCH") return json({ message: "Update is not a fast forward" }, 422);
    return null;
  });

  assert.equal(await pushEmptyCommit(nextInstallation(), "acme", "web", "setup", "m"), null);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1, "a rejected update is not retried with force");
});

test("a branch that is not there returns null without creating a commit", async () => {
  const calls = stubGitHub((u, method) => {
    if (u.includes("/git/ref/heads/gone") && method === "GET") return json({ message: "Not Found" }, 404);
    return null;
  });

  assert.equal(await pushEmptyCommit(nextInstallation(), "acme", "web", "gone", "m"), null);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "nothing is written when the branch is missing");
});
