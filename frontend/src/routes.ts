// The <Route> table app.tsx renders and routing.test.ts exercises. Other call sites
// still hardcode these URLs, so this is not yet the app's only copy of them.
// Param names are a contract: the screens read them straight off useParams().
export const ROUTE_PATHS = {
  agent: "/agent",
  review: "/reviews/:reviewId",
  workflow: "/workflow",
  bounty: "/bounty",
  fundBounty: "/bounties/:id/fund",
  cancelBounty: "/bounties/:id/cancel",
  security: "/security",
  securityFinding: "/security/findings/:findingId",
  securityGate: "/security/gate",
  securityRulings: "/security/rulings",
  securityPolicy: "/security/policy",
  settings: "/settings",
  settingsSection: "/settings/:section",
  root: "/",
  catchAll: "*",
} as const;

// Where the redirect-only routes send the browser.
export const DEFAULT_ROUTE = ROUTE_PATHS.agent;
export const DEFAULT_SETTINGS_PATH = "/settings/account";
