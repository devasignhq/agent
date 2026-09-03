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

Local run against a dev backend: mint a token with `backend/scripts/verify-dev-token.ts`, then `devasign-verify run --api-url http://localhost:8787 --token <jwt> --pr <n> --sha <head-sha>`. Offline: `--plan-file plan.json --results-out results.json`.
