# DEVASIGN.md

Conventions for this repository, read by DevAsign's own review agent. Each rule
is a single checkable sentence. Newly introduced violations are flagged as
nits — they don't block the merge. See [README.md](README.md#guiding-the-review-with-devasignmd)
for how this file is used and scoped.

## Backend (`backend/`)
- Imports use explicit `.js` extensions on relative paths (TypeScript NodeNext ESM).
- All Claude / LLM calls go through `complete()` in `backend/src/llm.ts`; pass
  `cacheSystem: true` when the system prompt is static.
- GitHub REST calls go through the `gh()` helper in `backend/src/github/app.ts`;
  the documented exceptions are raw blob reads via `installationToken` and the
  OAuth user-token identity calls (`/user`, `/user/emails`) in
  `backend/src/github/oauth.ts`, which need the user's OAuth token rather than an
  installation token.
- Persistence goes through the `db` helper (`db.insert/update/find/filter`); do
  not write raw SQL in feature code.
- A review finding only blocks a merge when its severity is `blocker`; advisory
  findings use `warn` or `nit`.

## Frontend (`frontend/`)
- The browser talks to the backend only through the typed client in
  `frontend/src/api.ts` — no ad-hoc `fetch` to API routes from components.
- Styling uses the shared design tokens in `frontend/src/styles.css` (CSS
  variables like `--accent`, `--fg-dim`), not hard-coded hex values.
