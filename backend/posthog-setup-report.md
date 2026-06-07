<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the DevAsign backend. A shared singleton client (`src/posthog.ts`) is imported across seven files to capture 16 distinct business events. Users are identified on every sign-in and sign-up so backend events are linkable to any future frontend session replays or error tracking. Exception autocapture is enabled on the PostHog client, and the global Express error handler passes caught errors to `captureException`. The server flushes PostHog gracefully on `SIGINT`/`SIGTERM` alongside the database shutdown.

| Event | Description | File |
|---|---|---|
| `user signed up` | New user completed GitHub OAuth for the first time | `src/github/oauth.ts` |
| `user signed in` | Existing user completed GitHub OAuth | `src/github/oauth.ts` |
| `account restored` | User logged back in, restoring a pending-deletion account | `src/github/oauth.ts` |
| `linear workspace connected` | User completed Linear OAuth flow | `src/linear/oauth.ts` |
| `checkout initiated` | User started a Stripe Checkout session | `src/routes/api.ts` |
| `plan changed` | User switched paid tier or billing interval | `src/routes/api.ts` |
| `integration connected` | User added a third-party integration via POST /integrations | `src/routes/api.ts` |
| `integration disconnected` | User removed a third-party integration | `src/routes/api.ts` |
| `attachment added` | User added an attachment to a task on the agent page | `src/routes/api.ts` |
| `subscription activated` | Stripe confirmed checkout completed and subscription is active | `src/billing/stripe.ts` |
| `payment failed` | Stripe reported an invoice payment failure | `src/billing/stripe.ts` |
| `pr review queued` | PR opened or synchronised via GitHub webhook and queued for AI review | `src/github/webhooks.ts` |
| `github app installed` | GitHub App installation webhook created an install row | `src/github/webhooks.ts` |
| `github app uninstalled` | GitHub App installation was deleted or removed | `src/github/webhooks.ts` |
| `account deletion requested` | User requested soft-deletion (14-day restore window) | `src/account.ts` |
| `account purged` | Account was permanently purged after the restore window expired | `src/account.ts` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics (wizard) — Dashboard](https://us.posthog.com/project/456804/dashboard/1677081)
- [New signups over time](https://us.posthog.com/project/456804/insights/U9OOJWGJ)
- [Signup to paid conversion funnel](https://us.posthog.com/project/456804/insights/vymJ3tDx)
- [PR reviews queued over time](https://us.posthog.com/project/456804/insights/TFWsqGXe)
- [Churn signal: account deletions requested](https://us.posthog.com/project/456804/insights/JajqeofO)
- [Integration adoption: GitHub installs & Linear connections](https://us.posthog.com/project/456804/insights/fAa14TKY)

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
