# devasignhq/verify-action

Runs [DevAsign](https://www.devasign.ai)'s generated acceptance tests for a pull request inside your own CI — the same way you'd add any test step — and posts a per-criterion verdict with evidence (test file, log, and a recording for browser tests) back on the PR. There is **no dashboard setup**: install the DevAsign GitHub App, add the step below, and the next PR is verified.

```yaml
name: DevAsign verify
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  id-token: write   # the runner authenticates to DevAsign with the job's OIDC token
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - uses: devasignhq/verify-action@v1
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}   # map whatever your tests need; DevAsign never sees these
```

How it behaves:

- Generated tests are written under `.devasign/`, run, uploaded as evidence, and deleted. Your `package.json`, lockfile and Playwright config are never modified.
- Every Playwright test is recorded (video + trace + screenshot) under a generated config that extends yours.
- A failing generated test is retried twice; a test that passes on retry is reported as flaky, never as a failure.
- A repository with no test framework still works: the runner brings its own.
- The step exits 0 regardless of the verdict — the `DevAsign · Verify` check run carries it. Set `fail-on: verdict` to fail the job on a failed criterion.
- Set `verify.start` / `verify.url` in `.devasign.yml` so end-to-end tests can boot your app; without them, UI criteria are reported as unverifiable, not failed.

| Input | Default | Meaning |
|---|---|---|
| `api-url` | `https://devasign-agent.onrender.com` | DevAsign API origin |
| `fail-on` | `never` | `verdict` fails the job on a failed criterion |
| `version` | `1` | `@devasign/verify` version range |
| `working-directory` | `.` | checkout directory to verify |
