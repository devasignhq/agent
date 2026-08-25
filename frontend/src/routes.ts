// The app's URL surface in one place, so app.tsx and routing.test.ts cannot drift.
// Param names are a contract: the screens read them straight off useParams().
export const ROUTE_PATHS = {
  agent: "/agent",
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

export type RouteKey = keyof typeof ROUTE_PATHS;

// Where the redirect-only routes send the browser.
export const DEFAULT_ROUTE = ROUTE_PATHS.agent;
export const DEFAULT_SETTINGS_SECTION = "/settings/account";
