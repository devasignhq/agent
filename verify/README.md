# @devasign/verify

The runner half of DevAsign verification. It runs inside your CI job (see [devasignhq/verify-action](../verify-action)), asks DevAsign for the test plan of the current pull request, runs it with your repository's own tooling — or its bundled runner when you have none — records every browser test, and uploads the evidence. The verdict is judged by DevAsign and posted on the PR; this tool only runs tests and reports what happened.

```bash
npx @devasign/verify run --api-url https://devasign-agent.onrender.com
```

Commands: `run` (default), `detect` (print the detected test setup), `doctor` (setup diagnostics for end-to-end tests). `--help` lists every option.

Guarantees:

- Writes only under `.devasign/` and removes it at the end (`--keep` to inspect).
- Never edits `package.json`, lockfiles, or `playwright.config.*`; generates `.devasign/playwright.config.ts` that extends yours with `video: 'on'`, `trace: 'on'`, `screenshot: 'on'`.
- A failing generated test is retried twice; pass-after-retry is `flaky`, never `fail`. Your own tests are never retried by us.
- Setup problems (no start command, missing secret names, wrong runtime) are uploaded as a structured diagnosis, and the process exits 0.

## Booting the app for browser tests

Browser tests need the app running. Describe how it starts in the `verify:` block of `.devasign.yml`:

```yaml
verify:
  install: npm ci --prefix frontend && npm ci --prefix backend
  start: npm --prefix frontend run dev -- --port 5173   # the app the browser opens
  url: http://localhost:5173
  ready: /                                              # optional: path on url, or a URL, polled until it answers
  timeout: 240                                          # optional: seconds per managed boot step, 10–900, default 180
  servers:                                              # optional: up to 4, started in order before `start`
    - name: api                                         # lowercase letters, digits and hyphens; not app, install, build, seed or login
      start: npm --prefix backend start
      url: http://localhost:8787
      ready: /health
  login:                                                # optional: browser tests start signed in
    script: node scripts/devasign-login.mjs
    check: http://localhost:8787/api/me
  env: [DATABASE_URL]                                   # secret names the job must provide
```

- **`start` / `url` only:** the runner hands them to Playwright's `webServer` (with `install`, `build` and `seed` chained in front), and a `webServer` in your own `playwright.config` still wins. The output of the server the runner starts goes to the uploaded Playwright log, not to the job log.
- **`servers` or `login.script` set (managed boot, 1.6.0+):** the runner starts everything itself. `install`, `build` and `seed` run first, then each server, then `start`; each must answer below HTTP 500 at its `ready` URL (resolved against its own `url`) within `timeout` before the next step starts. A server whose `url` already answers before it is started (a leftover process holding the port) fails the boot rather than being tested. `start`, `url` and `servers` take precedence over any `webServer` in your `playwright.config`, which is ignored. Every process is stopped when the tests finish.
- **`login.script`** runs once every server is up, with two variables set:
  - `DEVASIGN_STORAGE_STATE`: the path to write a Playwright [storage state](https://playwright.dev/docs/auth) JSON file (`{ "cookies": [...], "origins": [...] }`), for example with `context.storageState({ path })` after signing in.
  - `DEVASIGN_BASE_URL`: the value of `url`.

  It must exit 0 within 120 seconds. Generated browser tests start with that session; your repository's own Playwright tests never get it. The file lives in `.devasign/auth/`, is deleted right after the tests (also when the job is cancelled), and is never uploaded. Sign in as a **test-only account** and mint sessions that **expire within an hour**: the videos and screenshots show whatever the signed-in pages show.
- **`login.check`** (a path on `url`, or an absolute URL) is requested with the session's cookies and `Origin` set to `url`'s origin, and must answer 2xx within 10 seconds. A check on another origin must also answer `Access-Control-Allow-Origin` equal to that origin and `Access-Control-Allow-Credentials: true`, as the browser will need. Without `check`, the log says the session was not checked.
- **When boot fails,** the run reports a setup diagnosis instead of test failures: `app_not_ready` for a server that exits or never answers, `install_failed` for a failed install or build, and `login_failed` for a login script that fails, writes no storage state, or a session check that does not pass. Browser tests are reported as errors and the process still exits 0.
- **Logs:** each step's output is uploaded as `.devasign/artifacts/logs/boot-<name>.log`. Before any log is uploaded, the runner replaces the values of the variables listed in `env`, of variables whose names contain `SECRET`, `TOKEN`, `KEY`, `PASS`, `DATABASE_URL`, `COOKIE` or `SESSION`, `Cookie`, `Set-Cookie`, `Authorization`, `Proxy-Authorization`, `X-Api-Key` and `apikey` headers, and every string in the saved session (cookie, localStorage and IndexedDB values, including tokens nested in JSON, URL-encoded or base64 values) with `[redacted]`. A signed-in run's Playwright traces get the same treatment; a trace that cannot be rewritten is not uploaded. Values the app derives from the session some other way (a token fetched after sign-in and never stored) are not known to the runner, so keep test sessions short-lived.

Local run against a dev backend: mint a token with `backend/scripts/verify-dev-token.ts`, then `devasign-verify run --api-url http://localhost:8787 --token <jwt> --pr <n> --sha <head-sha>`. Offline: `--plan-file plan.json --results-out results.json`.

Exit code: 0 unless `--fail-on verdict` (a criterion failed) or `--fail-on unverifiable` (a criterion failed or could not be verified) is set; unset, the repository's DevAsign setting applies. An unknown `--fail-on` value exits 2. Criteria the plan could not cover are printed as warnings with their reason and fix link, and the Actions step summary lists every criterion. On Actions the CLI also writes `run-id`, `outcome` and `browsers` to `GITHUB_OUTPUT`.
