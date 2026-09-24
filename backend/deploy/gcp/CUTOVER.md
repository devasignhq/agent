# Render → Cloud Run cutover runbook

Moves the production API from Render (`https://devasign-agent.onrender.com`) to Cloud Run
(`devasign-api` in project `resounding-sled-478814-m2`, region `us-east4`). Neon stays the
database; nothing about the data moves.

**Window:** about 30 minutes, done in one sitting. Render and Cloud Run are both live from
step 2 to step 6. The database layer is built to handle that overlap (row versioning and a
delta-sync poller), but each instance runs its own background timers. The bounty keeper
moves real escrow funds, so Cloud Run doesn't get the Stellar key until Render is suspended
(step 7). That way two keepers never run at once.

**User-visible effects**
- Everyone is signed out once. The session cookie belongs to the Render host, and browsers
  won't send it to the new one.
- Webhooks that arrive while a URL is being switched could be missed. Stripe retries for
  3 days. GitHub doesn't retry on its own, but you can redeliver from the App's
  Advanced tab.
- Background jobs still in Render's in-memory queue when it's suspended are lost (step 6
  waits for a quiet queue first).

---

## Shared variables

Run everything from the checkout that holds the gitignored files the import script
generated (`backend/deploy/gcp/.env.cloudrun.yaml` and `.env.cloudrun.secrets`). Today that's
`/Users/ram/Documents/devasign-app/.claude/worktrees/app-navigation-sidebar-redesign-3dc50c`.
If those files are gone, re-run `import-render-env.mjs --apply`. It writes them again, and the
only side effect is an identical new version of each secret.

```bash
alias gcloud=~/google-cloud-sdk/bin/gcloud
export P=resounding-sled-478814-m2
export REGION=us-east4
export API=https://devasign-api-161910310724.us-east4.run.app   # deterministic: <service>-<project number>.<region>.run.app
export RENDER=https://devasign-agent.onrender.com
export IMAGE=us-east4-docker.pkg.dev/$P/devasign-api/api
export ENVDIR=backend/deploy/gcp
```

---

## Pre-flight (the day before; nothing here affects prod)

- [x] **P1. Check this project lets a Cloud Run service be public.** Done 2026-09-24.
  `--allow-unauthenticated` is **blocked**: the org policy rejects `allUsers` ("Setting IAM
  policy failed"), and the service stays private (403). `--no-invoker-iam-check` **works**:
  the service answered 200 to unauthenticated requests. So step 2 uses
  `--no-invoker-iam-check`. To re-check later (for example if org policies change):
  ```bash
  gcloud run deploy public-check --image=us-docker.pkg.dev/cloudrun/container/hello \
    --region=$REGION --project=$P --no-invoker-iam-check --quiet
  curl -s -o /dev/null -w "%{http_code}\n" "$(gcloud run services describe public-check --region=$REGION --project=$P --format='value(status.url)')"   # expect 200
  gcloud run services delete public-check --region=$REGION --project=$P --quiet
  ```
  If that ever returns 403, or the deploy is refused (an org policy such as
  `run.managed.requireInvokerIam`), stop: the org policy needs an exception first.

- [ ] **P2. Add `API_ORIGIN` to the env file.** This is safe to run more than once:
  ```bash
  grep -q '^API_ORIGIN:' $ENVDIR/.env.cloudrun.yaml || echo "API_ORIGIN: \"$API\"" >> $ENVDIR/.env.cloudrun.yaml
  grep -E '^(API_ORIGIN|WEB_ORIGIN|CONTRIBUTOR_ORIGIN|GITHUB_APP_NAME):' $ENVDIR/.env.cloudrun.yaml
  ```
  Expect `WEB_ORIGIN` to be `https://devasign-sponsor.vercel.app` and `GITHUB_APP_NAME` to be
  `devasign-agent`.

- [ ] **P3. Confirm the latest `main` image built.** Open Cloud Build → History (region
  **global**) and check that the newest `devasign-api-main` run is green. Its short SHA should
  match the newest backend merge on `main`.
  ```bash
  gcloud artifacts docker images list $IMAGE --include-tags --project=$P --format="value(tags,createTime)"
  ```

- [ ] **P4. Decide what ships.** Cloud Run runs the newest `main`. Render last booted
  2026-09-17, so check which backend merges it never ran:
  ```bash
  git log --first-parent origin/main --since="<Render bootedAt from $RENDER/api/health>" --oneline -- backend
  ```
  Deploying those to Render first means the cutover changes only the host. Letting them ship
  with the cutover is fine too, but then a problem afterwards could be either.

- [ ] **P5. Find where each OAuth callback is registered.** Add the new callback URLs now,
  wherever more than one is allowed:
  - **GitHub sign-in** (`GITHUB_OAUTH_CLIENT_ID` in the env file). Find which app owns that
    client ID. If it's an **OAuth App** (org → Developer settings → OAuth Apps), only one
    callback is allowed, so it changes in step 3. If it's the **GitHub App**
    `devasign-agent`, add `$API/api/auth/github/callback` as an extra Callback URL now.
  - **Linear** (Linear → Settings → API → your OAuth application): add
    `$API/api/auth/linear/callback` as an extra callback URL now.

- [ ] **P6. Prepare the verify action change.** In `devasignhq/verify-action`, open a PR that
  changes the `api-url` default in `action.yml` from `$RENDER` to `$API`, but don't merge it.
  Customer workflows use `@v1`, so step 5 moves that tag.

- [ ] **P7. Check access.** You'll need GitHub org admin, the Stripe dashboard, Linear admin,
  both Vercel projects (sponsor and contributor) and the Render dashboard.

- [ ] **P8. Pick a quiet window,** and warn users they'll be asked to sign in again.

---

## Cutover

### 1. Baseline Render (1 min)
```bash
curl -s $RENDER/api/health
```
Note `rowsLoadedAtBoot`, `bootedAt`, `writeThrough` (it must be `"ok"`) and `stellar` (it
should be `"live"`). In the Render logs, note the admin address on the `· Escrow:` line from
its last boot.

### 2. Create the prod service without Stellar (3 min)
Every prod secret except `STELLAR_ADMIN_SECRET`:
```bash
SECRETS=$(tr -d '\n' < $ENVDIR/.env.cloudrun.secrets | tr ',' '\n' | grep -v '^STELLAR_ADMIN_SECRET=' | paste -sd, -)
gcloud run deploy devasign-api --project=$P --region=$REGION \
  --image=$IMAGE:latest \
  --service-account=devasign-api@$P.iam.gserviceaccount.com \
  --min-instances=1 --max-instances=1 --no-cpu-throttling --cpu=1 --memory=2Gi \
  --timeout=3600 --concurrency=80 --execution-environment=gen2 --cpu-boost \
  --no-invoker-iam-check \
  --env-vars-file=$ENVDIR/.env.cloudrun.yaml \
  --set-secrets="$SECRETS" \
  --labels=env=prod
```
`--no-invoker-iam-check` makes the service public without an `allUsers` binding, which this
project's org policy forbids (see P1). The API does its own auth: session cookies,
webhook signatures, OIDC for verify.

Also check the service is reachable without credentials:
`curl -s -o /dev/null -w "%{http_code}\n" $API/api/health` should print `200` (a `403` means
the invoker check is still on).

**Verify before going on:**
```bash
curl -s $API/api/health
curl -s -D - -o /dev/null -H "Origin: https://devasign-sponsor.vercel.app" $API/api/health | grep -i access-control-allow-origin
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=devasign-api" \
  --project=$P --freshness=10m --order=asc --limit=40 --format="value(textPayload)"
```
- Health shows `db:"postgres"`, `writeThrough:"ok"`, `encryption:"ok"` and
  `stellar:"unconfigured"` (that's intended for now).
- `rowsLoadedAtBoot` is **at least** Render's step 1 number; it's usually higher.
- The CORS header shows `https://devasign-sponsor.vercel.app`.
- The startup log shows `[db] connected [ep-…us-east-1.aws.neon.tech/…]`, the prod host (not
  `ep-old-lab`, which is dev), then `Webhook: signature verified`, `App events … (all
  required ✓)`, and `Escrow: disabled`.

If anything is off, delete the service (`gcloud run services delete devasign-api --region=$REGION --project=$P`)
and stop. Render hasn't been touched.

### 3. Repoint webhooks and OAuth (5 min)
| Where | Field | New value |
|---|---|---|
| GitHub → org → GitHub Apps → `devasign-agent` → General | Webhook URL | `$API/api/webhooks/github` (the secret stays the same) |
| The OAuth App from P5 (if it's an OAuth App) | Authorization callback URL | `$API/api/auth/github/callback` |
| Stripe → Developers → Webhooks → the existing endpoint → Update details | Endpoint URL | `$API/api/webhooks/stripe`. **Edit** the existing endpoint; a new one would get a new signing secret. |
| Linear → your OAuth application | Webhook URL | `$API/api/webhooks/linear` |

Verify: in the GitHub App's Advanced tab, redeliver the most recent delivery and expect
**200**. In Stripe, "Send test webhook" should return 200.

### 4. Point both frontends at the new API (5–8 min)
In Vercel, for **both** the sponsor and the contributor projects, open Settings → Environment
Variables and set `VITE_API_BASE` = `$API` for **Production and Preview**. Then open
Deployments, find the latest production deployment and choose **Redeploy**. Vite bakes this
value in at build time, so without a redeploy nothing changes.

Verify: sign in on `https://devasign-sponsor.vercel.app`. The `devasign_session` cookie should
now be on `devasign-api-161910310724.us-east4.run.app`, marked `HttpOnly; Secure;
SameSite=None`. Sign in on the contributor app as well.

### 5. Move the verify action (2 min)
Merge the P6 PR in `devasignhq/verify-action`, tag it, and move `v1`:
```bash
git tag v1.1.3 && git push origin v1.1.3
git tag -f v1 v1.1.3 && git push -f origin v1
```
Verify: the next customer verify run calls `$API`, which you can see in the Cloud Run logs.

### 6. Suspend Render (2–5 min)
In Render's logs, wait until no `[worker]` job has started in the last minute or two. Then
open Render → the service → Settings → **Suspend Web Service**. Render sends SIGTERM and gets
30s to flush its pending writes to Neon. Within about 2s, Cloud Run's sync poller picks up
anything Render wrote.

Verify: `curl -s $RENDER/api/health` no longer answers, and `curl -s $API/api/health` still
shows `writeThrough:"ok"`.

### 7. Hand the escrow keeper to Cloud Run (2 min)
**Only after step 6.** This adds the Stellar key and rolls out a new revision:
```bash
gcloud run services update devasign-api --project=$P --region=$REGION \
  --update-secrets=STELLAR_ADMIN_SECRET=STELLAR_ADMIN_SECRET:latest
```
Verify: health shows `stellar:"live"`. The new revision's `· Escrow:` log line should list
the same network, contract and **admin address** as Render's (from step 1).

### 8. Switch automatic deploys on (1 min)
```bash
gcloud builds triggers update github devasign-api-main --project=$P --update-substitutions=_DEPLOY=true
```
From now on, each backend merge to `main` runs the tests, builds, pushes and deploys that
image to `devasign-api`. The env, secrets and scaling configured above stay as they are.

### 9. Smoke test (5 min)
- [ ] Both apps: sign in, load the dashboard, check notifications stream (no reconnect loop).
- [ ] Open or push to a test PR and watch the review finish (`[worker] review …` in the logs).
- [ ] Linear: connect or disconnect works, or an ingest webhook arrives with a 200.
- [ ] Stripe: the test webhook from step 3 returned 200.
- [ ] Run `curl -s $API/api/health` again after 10 minutes: `writeThrough:"ok"` and
  `pendingWrites:0`.

To see which commit prod is running now:
`gcloud run services describe devasign-api --region=$REGION --project=$P --format='value(spec.template.spec.containers[0].image)'`

---

## Rollback

The durability barrier means every write Cloud Run acknowledged is already in Neon, so Render
loads it all when it boots again.

**Before step 6 (Render still running):** reverse steps 5 → 3. Point the webhooks, OAuth,
Vercel `VITE_API_BASE` (then redeploy) and verify-action `v1` (back to `v1.1.2`) at `$RENDER`.
Then:
```bash
gcloud run services delete devasign-api --region=$REGION --project=$P --quiet
```

**After step 6:**
1. First make sure only one escrow keeper can run. Turn Cloud Run's off:
   `gcloud run services update devasign-api --region=$REGION --project=$P --remove-secrets=STELLAR_ADMIN_SECRET`
2. `gcloud builds triggers update github devasign-api-main --project=$P --update-substitutions=_DEPLOY=false`
3. Resume Render (Render → Settings → **Resume**). Wait for `$RENDER/api/health` to show
   `rowsLoadedAtBoot` at least as high as Cloud Run's.
4. Reverse steps 5 → 3 as above.
5. Delete the Cloud Run service.

---

## After cutover
- Keep the Render service suspended, not deleted, for about a week. It's your fastest rollback.
- Add a Cloud Monitoring uptime check on `$API/api/health` that alerts when the response
  contains `"stalled"` or the check fails.
- Update the docs and examples that still mention the Render URL:
  `verify-action/action.yml` and `README.md`, `verify/README.md`,
  `frontend/.env.example`, `contributor/.env.example`, and the `VITE_API_BASE` error text in
  both `vite.config.ts` files.
- Remove the GitHub and Linear callback URLs that point at Render.
- Optional: put a custom domain (`api.devasign.ai`) in front, so the next move doesn't mean
  repointing everything again.
