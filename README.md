# DevAsign

Multimodal AI agent that reviews PRs against the actual ticket — not just the
diff. It pulls context from GitHub, Linear, Slack/Discord, Figma, Loom,
screenshots and PDFs, synthesizes an **End goal** (the acceptance criteria the
PR must meet), reviews the change against it, and posts a verdict back as a
GitHub Check Run + PR review while broadcasting to your chat tool.

On top of review, DevAsign turns issues into **funded bounties**: maintainers
escrow USDC on Stellar (Soroban), contributors apply and submit work, and the
same review engine gates the payout.

Review is a judgement; **verification** is evidence. DevAsign generates
acceptance tests for a PR's criteria, runs them **inside your own CI** — your
runners, your secrets, your code never leaves your infrastructure — and reports
per-criterion pass/fail with browser recordings attached to the PR.

## Repository layout

This repo holds three apps that share one backend, plus the two packages that
run verification in your CI:

- [`backend/`](backend) — Node + Express API: GitHub OAuth + GitHub App,
  webhook receiver, in-memory job queue, review worker, LLM client (Claude on
  Anthropic, or Gemini on Vertex AI), Stellar/Soroban escrow, Stripe billing,
  and a Postgres-backed store (Neon). Implements the spine described in
  [`design.md`](design.md). Ships as a container to Google Cloud Run (see
  **Deployment** below).
- [`frontend/`](frontend) — the **maintainer** dashboard (Vite + React + TS).
  Terminal/CLI dark theme, Geist + Geist Mono, orange accent `#ff7a3d`.
- [`contributor/`](contributor) — the standalone **contributor** app (Vite +
  React + TS): bounty discovery, apply, dashboard, and wallet.
- [`verify/`](verify) — [`@devasign/verify`](verify/README.md), the Node CLI that
  runs the generated tests on your runner and uploads evidence.
- [`verify-action/`](verify-action) — the composite GitHub Action wrapping that
  CLI (`devasignhq/verify-action@v1`).

The two frontends are separate apps with separate accounts (a maintainer
account and a contributor account are distinct even for the same GitHub
identity); the backend scopes its session cookie by `Origin`.

## Quickstart

### Backend

```bash
cd backend
cp .env.example .env       # fill in keys when you have them; mock mode works without
npm install
npm run dev                # http://localhost:8787
```

What works out of the box:

- `GET  /api/health` — sanity check
- `POST /api/webhooks/github` — receives PR / installation / comment events,
  enqueues review jobs (also mounted at `/`)
- `GET  /api/reviews`, `GET /api/reviews/:id`, `POST /api/reviews/:id/rerun`
- `GET  /api/repositories`, `POST /api/repositories/:id/reindex`,
  `GET/PUT /api/repositories/:id/workflow` (per-repo review config)
- `POST /api/tasks/:id/attachments` — Loom / Figma / image / PDF added by the user
- `GET  /api/bounties`, `POST /api/bounties`, and the funding / apply / submit /
  payout lifecycle (see **Bounties** below)
- `GET  /api/security/overview`, `POST /api/security/scan` (see **Security** below)
- `GET  /api/reviews/:id/verify`, `POST /api/reviews/:id/verify/{adopt,archive}`,
  `GET  /api/verify/tests`, `GET/POST /api/repositories/:id/verify/setup[-pr]`,
  `POST /api/repositories/:id/verify/{boot-check,recheck}` (see **Verification** below)
- `POST /v1/runs/resolve`, `POST /v1/runs/:id/results`, `POST /v1/runs/:id/artifacts`,
  `GET /v1/runs/:id`, `POST /v1/probes/:id/{result,artifacts}` — the **runner
  API**, mounted at `/v1` and authenticated by GitHub OIDC rather than a session
  cookie
- `GET  /api/me`, `GET /api/integrations`, `GET /api/billing/subscription`,
  `GET /api/notifications/stream` (SSE), …

Without an `ANTHROPIC_API_KEY` the LLM step uses a deterministic mock that emits
properly-shaped JSON, so the rest of the pipeline (ingest → criteria → review →
output → log) still runs end-to-end. Drop in a key to flip to live Claude. Video
understanding (Loom / screen recordings) runs on Gemini when `GEMINI_API_KEY` is
set, and is skipped otherwise.

Set `LLM_PROVIDER=vertex` to route **every** LLM call (reviews, structured
output, the repo-lookup tool loop, PDFs/images, video) to Gemini on Vertex AI
instead (`VERTEX_MODEL`, default `gemini-3.8-flash`). It authenticates with the
runtime service account, or `gcloud auth application-default login` locally;
`VERTEX_THINKING` caps the thinking level (default `medium`) and
`VERTEX_PRIORITY=1` opts into Priority PayGo. Anthropic stays the default.

### Frontend (maintainer dashboard)

```bash
cd frontend
npm install
npm run dev                # http://localhost:3001, proxies /api → 8787
```

Screens, as grouped in the sidebar:

- Auth (GitHub OAuth gate) and Onboarding (plan → configure repositories →
  connect workspace; the integrations step is Pro/Max only)
- **Workspace**
  - Agents — PR queue, review log timeline, end-goal panel, multimodal
    composer, and the per-criterion verification panel with its recordings
  - Tests — every test from each PR's newest verify run: filter by repo,
    end-to-end/unit, status and generated/existing; evidence with a deletion
    countdown; adopt, archive (older PRs' tests auto-archive), and dismissible
    browser-setup warnings
  - Workflow — per-repo review models, stage toggles, and the verification
    boot config (the command and URL CI boots for browser tests)
  - Bounties — list, drawer, create/fund modal, applications inbox, invoice
    PDF; shown only when bounties are switched on under Account
- **Security** — Reports (scans, findings by severity, one-click issue →
  bounty, CSV/PDF export) and Configuration (gate, rulings/precedents, policy)
- **Settings** — Repository (GitHub installs), Integrations (Linear, Slack,
  Discord), Billing (plan, usage, invoices)
- Help & Resources, and Account (profile, feature switches, deletion)
- ⌘K command center and a Tweaks panel (accent / density / sidebar / mono font)

Old `/settings/:section` URLs redirect to the page each section became.

### Contributor app

```bash
cd contributor
npm install
npm run dev                # http://localhost:3002, proxies /api → 8787
```

Screens: public **Discovery** → GitHub auth gate → **Dashboard**, **Bounties**
(apply, submit, request extension/payout), **Wallet** (Stellar payout address),
and **Settings**.

## Bounties & escrow

Bounties are backed by a **non-custodial** USDC escrow on Stellar (Soroban).
The backend never holds contributor funds:

- **Fund** — the sponsor signs `create_escrow` with Freighter; the backend only
  builds the unsigned XDR and submits the signed transaction.
- **Release** — the sponsor can release in-app (Freighter-signed), and the
  backend releases with an admin/arbiter key when a linked PR merges.
- **Refund** — the admin key refunds on cancel/expiry.

Lifecycle: create → fund → apply → accept (assign) → submit → review → payout or
refund, with **timeline extensions** (contributor requests, sponsor approves)
and a **rejection/dispute** path. When a bounty is funded its acceptance
criteria are locked and seeded into the review engine, so the same End-goal
review that gates a normal PR also gates the payout.

Stellar config lives under `STELLAR_*` in `backend/.env.example`
(`STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_ESCROW_CONTRACT_ID`,
`STELLAR_USDC_*`, `STELLAR_ADMIN_SECRET`, …).

## Security audit

The agent scans a repository for vulnerabilities and tracks findings over time
(`backend/src/security/`). Findings are **fingerprinted** so they survive
re-scans, ranked into four severity tiers, and confidence caps severity
(unconfirmed findings can't exceed medium). A finding surfaces only after it
passes a mechanical evidence check and an independent verifier whose code
citations are checked; anything else stays hidden as `unverified`. A
`devasign/security` Check Run reports the gate, precedents/policy let a repo
suppress or accept classes of findings, and a maintainer can turn any finding
into a GitHub issue — and from there a funded bounty — in one click. Findings
can be exported (CSV/PDF) on paid plans.

## Verification

Review argues that a PR meets its criteria; verification *demonstrates* it.
DevAsign generates acceptance tests from the End goal, and they run **in your
CI, on your runners** — the code and secrets never leave your infrastructure,
and this backend only ever sees results and recordings.

Add the Action to a workflow:

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write        # required — the runner authenticates by OIDC
    steps:
      - uses: actions/checkout@v4
      - uses: devasignhq/verify-action@v1
        # with:
        #   fail-on: verdict   # opt in to blocking (or `unverifiable`); default never fails the job
```

or run the CLI directly with `npx @devasign/verify run`. Either way the runner
authenticates with the workflow's **GitHub OIDC token** (`VERIFY_OIDC_AUDIENCE`),
not an API key you have to store.

How a run works:

1. **Plan** — the runner calls `POST /v1/runs/resolve` with its OIDC token and
   gets the test plan for that PR head SHA.
2. **Run** — it executes the plan with your repo's own tooling, or its bundled
   Playwright runner when you have none, recording video, trace and screenshots.
3. **Report** — results go to `POST /v1/runs/:id/results`; artifacts upload by
   signed `PUT` straight to object storage, so the bytes never pass through this
   server.
4. **Judge** — DevAsign scores per-criterion `pass` / `fail` / `unverifiable` /
   `pending`, writes a `### Verification` section into the review comment, and
   posts a separate **`DevAsign · Verify`** Check Run.

Deliberate properties:

- **Not a merge gate.** The Action's `fail-on` defaults to `never`, so
  verification reports evidence without blocking your merges until you opt in
  with `verdict` (fail on a failed criterion) or `unverifiable` (also fail when
  a criterion could not be verified).
- **Nothing is silent.** A criterion no test could cover is announced as a CI
  warning with its reason and a fix link; the step summary lists every
  criterion, not just the tests that ran.
- **Flakes aren't failures.** A failing generated test is retried twice;
  pass-after-retry is recorded as `flaky`, never `fail`. Your own tests are
  never retried.
- **Setup problems are diagnosed, not failed.** A missing start command or
  secret is uploaded as a structured diagnosis and the job still exits 0.
- **The runner is a guest in your repo.** It writes only under `.devasign/` and
  cleans up after itself; it never edits `package.json`, lockfiles, or your
  `playwright.config.*`.
- **Recordings expire.** A retention sweep deletes artifacts after 30 days
  and marks the row expired, so the UI says "recording expired"
  instead of breaking.

Getting set up is one click: DevAsign detects your stack and opens an onboarding
PR on branch `devasign/enable-verification` adding
`.github/workflows/devasign-verify.yml` and a `verify:` block in `.devasign.yml`:

```yaml
verify:
  e2e: auto                 # auto | always | never
  install: npm ci
  servers:                  # up to 4, started in order before `start`
    - name: backend
      start: npm --prefix backend run dev
      url: http://localhost:8787
      ready: /api/health
  start: npm --prefix frontend run dev -- --port 3001 --strictPort
  url: http://localhost:3001  # the app the browser opens
  ready: /
  timeout: 180              # seconds each managed-boot step may take
  login:
    script: node scripts/login.mjs  # writes a Playwright storageState
    check: /api/me          # must answer 2xx with that session
  services: [postgres]      # postgres | mysql | redis
  env: [DATABASE_URL]       # secret names the job must provide (scrubbed from logs)
```

Browser (end-to-end) tests need `start` + `url`; `servers` or a `login.script`
switch the runner to **managed boot** (CLI ≥ 1.6), which starts every process,
checks the signed-in session with the app's `Origin`, scrubs secrets and session
values from uploaded logs and traces, and stops everything on the way out.
Generated browser tests start signed in; your own tests never do.

Boot config is **inferred** from your packages (root or nested, reading the
app's own dev-server port), and the Workflow page's setup drawer shows what
inference settled and asks for the rest, committing your answers to the setup
PR. The setup PR's own CI then **proves** the proposed config — boots it, loads
the page, signs in — and DevAsign reports back on the PR ("Came up at … in 41s
— signed in"). An already-onboarded repo can re-prove its config at any time
with a boot check against the default branch.

`devasign-verify doctor` diagnoses a setup locally, and any generated test can
be **adopted** into your own suite from the PR in one click.

## The review pipeline

Per [`design.md`](design.md), the worker drains a job per PR and runs, in order:

1. **Ingest** — gather PR + repo context, linked Linear issue, and attachments;
   summarize any videos via Gemini.
2. **Holistic** — retrieve the whole-repo index (when built) for cross-file context.
3. **Criteria / End goal** — synthesize acceptance criteria, seeded from a
   linked bounty (locked at funding) or Linear ticket, refined by video. The
   review can read files **outside the diff** (a read-only `read_repo_file`
   tool pinned to the PR head, plus `git check-ignore` facts for ignore-rule
   criteria); a criterion it still can't check is `unverifiable`, and when
   only those remain the review is a neutral comment rather than a block.
4. **New-commit intent review** — on re-review, judge new commits against their
   own commit-message intent and the incremental delta.
5. **Defect review** — a correctness pass ("is this code right?") independent of
   the spec, so it still runs when no index/spec exists.
6. **Output & log** — post the Check Run + PR review and record a timeline.

Verification runs as its own job loop beside this one (`verify_plan`,
`verify_judge`, `verify_feedback`, `verify_onboard`) rather than as a step
inside it, because it waits on your CI. Output joins whatever has landed within
`VERIFY_JOIN_TIMEOUT_MS` and posts the rest as `pending`, so a slow CI run never
holds up the review.

Maintainer feedback can **re-score** existing verdicts (clear false positives,
re-open passed criteria), not just add criteria.

## What's implemented vs. stubbed

| Layer | Status |
|---|---|
| Identity (GitHub OAuth) | ✅ real OAuth flow; falls back to error if creds missing |
| GitHub App install + JWT + installation tokens | ✅ signing, token caching, REST helper |
| Webhook receiver (HMAC) | ✅ verifies sha256; routes `installation`, `installation_repositories`, `pull_request`, `issue_comment` |
| Review pipeline | ✅ ingest → holistic → criteria → new-commit → defect → output → log |
| LLM (Claude / Gemini on Vertex) | ✅ Claude when key set, Gemini on Vertex with `LLM_PROVIDER=vertex`, deterministic mock otherwise |
| Video understanding (Gemini) | ✅ live when `GEMINI_API_KEY` set (or via Vertex), skipped otherwise |
| Job queue | ✅ in-memory (stand-in for Cloud Tasks); one worker drains it |
| Persistence | ✅ Postgres (Neon); in-memory snapshot at boot, resilient write-through on mutation |
| Bounties + Stellar/Soroban escrow | ✅ non-custodial (Freighter-signed create/release, admin-signed release/refund); contract deploy is environment config |
| Security audit | ✅ fingerprinted findings, severity tiers, verifier gate, precedents/policy, issue → bounty |
| Verification (tests in your CI) | ✅ OIDC-authenticated runner API, `@devasign/verify` CLI + `verify-action`, managed multi-process/signed-in boot, boot inference + CI-proven setup, own Check Run, signed-URL artifacts, retention sweep |
| Deployment | ✅ Docker image → Google Cloud Run via Cloud Build (Node 24) |
| Integrations | ✅ Slack & Discord broadcast; Linear OAuth + ingestion + webhooks |
| Billing (Stripe) | ✅ live when `STRIPE_SECRET_KEY` set: checkout, portal, plan changes, credits |
| Notifications | ✅ per-user SSE stream + live row-change fan-out |
| Eval harness | out-of-band (see the `evals` repo) — not in the request path |

## Environment

Keys are grouped in [`backend/.env.example`](backend/.env.example); both
frontends only need `VITE_API_BASE`. Notable groups:

- **GitHub** — `GITHUB_OAUTH_*`, `GITHUB_APP_*` (id, name, webhook secret, private key)
- **LLM** — `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`, `GEMINI_API_KEY` / `GEMINI_MODEL`,
  and `LLM_PROVIDER` + `VERTEX_*` (project, location, model, thinking, priority,
  per-MTok prices) for Gemini on Vertex AI
- **Data & sessions** — `DATABASE_URL`, `SESSION_SECRET`, `INTEGRATION_ENCRYPTION_KEY`
- **Origins** — `WEB_ORIGIN` (maintainer app), `CONTRIBUTOR_ORIGIN` (contributor app)
- **Stellar** — `STELLAR_*` (network, RPC/Horizon, escrow contract, USDC, admin key)
- **Billing** — `STRIPE_*` (secret, price ids, webhook secret)
- **Integrations** — `SLACK_*`, `DISCORD_*`, `LINEAR_*`
- **Verifier** — `VERIFY_OIDC_*` (issuer, audience, JWKS), `VERIFY_JOIN_TIMEOUT_MS`,
  `VERIFY_RUN_TIMEOUT_MS`, and `ARTIFACT_S3_*` for the private recordings bucket
  (Cloudflare R2 or any S3-compatible store; unset = verify without recordings)
- **Ops** — `RESEND_API_KEY` / `EMAIL_FROM`, `STATSIG_*`

## Deployment

The API runs on **Google Cloud Run**. [`backend/Dockerfile`](backend/Dockerfile)
builds a Node 24 image and [`backend/cloudbuild.yaml`](backend/cloudbuild.yaml)
is the Cloud Build pipeline that tests, builds, pushes and deploys it on every
merge to `main` that touches `backend/` (the deploy step is switched by the
trigger's `_DEPLOY` substitution). The maintainer and contributor apps deploy
separately (Vercel); point `WEB_ORIGIN` and `CONTRIBUTOR_ORIGIN` at them
exactly. The runbook for the
Render → Cloud Run move, including env import
([`backend/deploy/gcp/import-render-env.mjs`](backend/deploy/gcp)) and rollback,
is [`backend/deploy/gcp/CUTOVER.md`](backend/deploy/gcp/CUTOVER.md).

## End-to-end smoke test

Once the backend is running:

```bash
curl -s -X POST http://localhost:8787/api/webhooks/github \
  -H "X-GitHub-Event: pull_request" \
  -H "Content-Type: application/json" \
  -d '{"action":"opened","installation":{"id":12345},"repository":{"id":1,"full_name":"acme/pay","default_branch":"main"},"pull_request":{"number":482,"title":"Multi-chain USDC withdraw","body":"Implements the flow described in #12.","head":{"sha":"abc"},"base":{"sha":"def"}}}'
```

You should see the job hit the queue, the worker run ingest → criteria → review,
and the resulting record persist to Postgres (Neon) along with the log entries on
the timeline (`Pipeline started`, `Context ingested`, `End goal synthesized`,
`Changes requested`, `Posted Check Run and PR review`).

## Guiding the review with `DEVASIGN.md`

Drop a `DEVASIGN.md` file into your repository to teach the review agent your
team's own conventions — the same way you'd use `AGENTS.md` or `CLAUDE.md`.
There is **no setup in the dashboard**: commit the file and the agent picks it
up on the next review.

How it behaves:

- **Hierarchical scope.** The agent reads a `DEVASIGN.md` at *every* level of
  your directory tree. The repo-root file governs everything; a
  `frontend/DEVASIGN.md` governs only files under `frontend/`. A file obeys
  every `DEVASIGN.md` on its path, root → leaf.
- **Violations are nits.** When a PR *newly* introduces a violation of a rule
  that governs a changed file, the agent posts it as a **nit-level** finding —
  surfaced with a copyable fix prompt, but it never blocks the merge.
  Pre-existing code is left alone; the agent flags only what the diff adds.
- **Docs stay honest (bidirectional).** If the diff changes code such that a
  `DEVASIGN.md` statement is now outdated, the agent flags that the docs need
  updating too.

### Starter template

```markdown
# DEVASIGN.md

Conventions for this directory and everything under it. Newly introduced
violations are flagged as nits; they don't block the merge.

## Conventions
- State each rule as a single, checkable sentence.
- Prefer concrete, observable rules ("API calls go through `src/api.ts`") over
  subjective taste ("write clean code").

## Examples
- Error handling: wrap external calls and surface a typed error, never throw raw.
- Naming: React components are PascalCase; hooks start with `use`.
```

Put broad rules in the root `DEVASIGN.md` and narrow, area-specific rules in a
`DEVASIGN.md` inside the relevant subdirectory.

## License

Copyright (C) 2026 DevAsign

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
this program. If not, see <https://www.gnu.org/licenses/>.
