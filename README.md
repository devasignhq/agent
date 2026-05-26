# DevAsign

Multimodal AI agent that reviews PRs against the actual ticket — pulling context from GitHub, Linear, Slack/Discord, Figma, Loom, screenshots, PDFs — then posts a verdict back as a GitHub Check Run + PR review and broadcasts to your chat tool.

This repo has two halves:

- [`frontend/`](frontend) — Vite + React + TypeScript dashboard, ported pixel-for-pixel from the Claude Design handoff (terminal/CLI dark theme, Geist + Geist Mono, orange accent `#ff7a3d`).
- [`backend/`](backend) — Node + Express API that implements the spine described in [`devasign.md`](devasign.md): GitHub OAuth + GitHub App, webhook receiver, in-memory job queue, review worker, Anthropic LLM client, JSON-backed store.

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
- `POST /api/webhooks/github` — receives PR / installation events, enqueues review jobs
- `GET  /api/reviews` — list of PR reviews
- `GET  /api/reviews/:id` — review + log timeline + linked task
- `POST /api/reviews/:id/rerun` — re-queue
- `POST /api/tasks/:id/attachments` — Loom / Figma / image / PDF added by the user
- `GET  /api/me`, `GET /api/integrations`, `GET /api/billing/subscription`, …

Without an `ANTHROPIC_API_KEY` the LLM step uses a deterministic mock that emits
properly-shaped JSON, so the rest of the pipeline (ingest → criteria → review →
output → log) still runs end-to-end. Drop in a key to flip to live Claude.

### Frontend

```bash
cd frontend
npm install
npm run dev                # http://localhost:5173, proxies /api → 8787
```

The dashboard ships the full design from the handoff bundle:

- Auth (GitHub OAuth gate)
- Onboarding (4 steps: GitHub install → integrations → IDE/CLI → wallet)
- Agents (PR queue + review log timeline + end-goal panel + multimodal composer)
- Bounties (list + drawer + applications inbox + create-bounty modal)
- Wallet (Stellar balance + withdraw with 2FA gate)
- Settings (Account, Installation, Review Models per repo, Usage, Plans, Security, Integrations)
- ⌘K command center
- Tweaks panel (accent / density / sidebar / mono font)

## What's implemented vs. stubbed

Per [`devasign.md`](devasign.md):

| Layer | Status |
|---|---|
| Identity (GitHub OAuth) | ✅ real OAuth flow; falls back to error if creds missing |
| GitHub App install + JWT + installation tokens | ✅ signing, token caching, REST helper |
| Webhook receiver (HMAC) | ✅ verifies sha256, routes `installation`, `installation_repositories`, `pull_request` |
| Review pipeline | ✅ ingest → criteria → review → output → log; multimodal context shape is in place |
| LLM (Claude) | ✅ live when key set, deterministic mock otherwise |
| Job queue | ✅ in-memory (stand-in for Cloud Tasks); one worker drains it |
| Persistence | ✅ JSON file (stand-in for Firestore); write-through cache |
| Integrations | Slack & Discord broadcast wired; Linear ingestion helper present |
| Billing (Stripe) | Subscription row + credit grant endpoint; no real Stripe wiring yet |
| Eval harness | Spec'd in `devasign.md` §5.e but out-of-band — not in the request path |

## End-to-end smoke test

Once both servers are running:

```bash
curl -s -X POST http://localhost:8787/api/webhooks/github \
  -H "X-GitHub-Event: pull_request" \
  -H "Content-Type: application/json" \
  -d '{"action":"opened","installation":{"id":12345},"repository":{"id":1,"full_name":"acme/pay","default_branch":"main"},"pull_request":{"number":482,"title":"Multi-chain USDC withdraw","body":"Implements the flow described in #12.","head":{"sha":"abc"},"base":{"sha":"def"}}}'
```

You should see the job hit the queue, the worker run ingest → criteria → review,
and the resulting record appear in `backend/data/db.json` along with five log
entries on the timeline (`Pipeline started`, `Context ingested`, `End goal
synthesized`, `Changes requested`, `Posted Check Run and PR review`).
