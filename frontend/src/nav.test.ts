// node --test src/nav.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { activeNavKey, HELP_ITEM, NAV_GROUPS, NAV_ITEMS, pageTitle, settingsRedirect, visibleNavGroups } from "./nav.ts";

test("the sidebar groups follow the sketch", () => {
  assert.deepEqual(NAV_GROUPS.map((g) => [g.label, g.items.map((i) => i.name)]), [
    ["Workspace", ["Agents", "Tests", "Workflow", "Bounties"]],
    ["Security", ["Reports", "Configuration"]],
    ["Settings", ["Repository", "Integrations", "Billing"]],
  ]);
  assert.equal(HELP_ITEM.path, "/help");
  assert.equal(new Set(NAV_ITEMS.map((i) => i.key)).size, NAV_ITEMS.length, "keys are unique");
});

test("Bounties only shows once the account turns it on", () => {
  const names = (u: any) => visibleNavGroups(u)[0].items.map((i) => i.name);
  assert.deepEqual(names(null), ["Agents", "Tests", "Workflow"]);
  assert.deepEqual(names({ bountiesEnabled: false }), ["Agents", "Tests", "Workflow"]);
  assert.deepEqual(names({ bountiesEnabled: true }), ["Agents", "Tests", "Workflow", "Bounties"]);
});

test("activeNavKey maps every URL family to its sidebar item", () => {
  const cases: Array<[string, string]> = [
    ["/", "agent"],
    ["/agent", "agent"],
    ["/reviews/rev-1", "agent"],
    ["/tests", "tests"],
    ["/workflow", "workflow"],
    ["/bounty", "bounty"],
    ["/bounties/b1/fund", "bounty"],
    ["/security", "security"],
    ["/security/findings/F-1", "security"],
    ["/security/config", "securityConfig"],
    ["/security/config?tab=gate", "securityConfig"],
    ["/security/gate", "security"],
    ["/repository", "repository"],
    ["/integrations", "integrations"],
    ["/billing", "billing"],
    ["/help", "help"],
    ["/account", "account"],
    ["/settings", "account"],
    ["/settings/billing", "billing"],
    ["/settings/support", "help"],
    ["/nope", "agent"],
  ];
  for (const [url, key] of cases) assert.equal(activeNavKey(url.split("?")[0]), key, url);
});

test("old settings sections redirect to the pages they became", () => {
  assert.equal(settingsRedirect("install"), "/repository");
  assert.equal(settingsRedirect("integrations"), "/integrations");
  assert.equal(settingsRedirect("billing"), "/billing");
  assert.equal(settingsRedirect("support"), "/help");
  assert.equal(settingsRedirect("account"), "/account");
  assert.equal(settingsRedirect(undefined), "/account");
  assert.equal(settingsRedirect("bogus"), "/account");
});

test("page titles come from the nav table", () => {
  assert.equal(pageTitle("securityConfig"), "Configuration");
  assert.equal(pageTitle("account"), "Account");
  assert.equal(pageTitle("unknown"), "Agents");
});
