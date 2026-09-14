// The app's navigation table: sidebar groups, page titles, and the pure
// URL → active-item mapping app.tsx uses. React-free so node --test covers it.
import type { User } from "./api.ts";

export type NavItem = {
  key: string;
  name: string;
  path: string;
  icon: string;
  when?: (user: Pick<User, "bountiesEnabled"> | null | undefined) => boolean;
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { key: "agent", name: "Agents", path: "/agent", icon: "agent" },
      { key: "tests", name: "Tests", path: "/tests", icon: "check" },
      { key: "workflow", name: "Workflow", path: "/workflow", icon: "workflow" },
      { key: "bounty", name: "Bounties", path: "/bounty", icon: "bounties", when: (u) => !!u?.bountiesEnabled },
    ],
  },
  {
    label: "Security",
    items: [
      { key: "security", name: "Reports", path: "/security", icon: "shield" },
      { key: "securityConfig", name: "Configuration", path: "/security/config", icon: "settings" },
    ],
  },
  {
    label: "Settings",
    items: [
      { key: "repository", name: "Repository", path: "/repository", icon: "repo" },
      { key: "integrations", name: "Integrations", path: "/integrations", icon: "link" },
      { key: "billing", name: "Billing", path: "/billing", icon: "swap" },
    ],
  },
];

export const HELP_ITEM: NavItem = { key: "help", name: "Help & Resources", path: "/help", icon: "doc" };
export const ACCOUNT_ITEM: NavItem = { key: "account", name: "Account", path: "/account", icon: "user" };

export const NAV_ITEMS: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), HELP_ITEM, ACCOUNT_ITEM];

export const MOBILE_TAB_KEYS = ["agent", "tests", "workflow", "security"];

export function navItem(key: string): NavItem | undefined {
  return NAV_ITEMS.find((n) => n.key === key);
}

export function pageTitle(key: string): string {
  return navItem(key)?.name ?? "Agents";
}

export function visibleNavGroups(user: Pick<User, "bountiesEnabled"> | null | undefined): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.when || i.when(user)) }));
}

// Old /settings/:section bookmarks (and the Stripe/Linear return paths) map to
// the pages those sections became.
const SETTINGS_SECTIONS: Record<string, string> = {
  install: "/repository",
  integrations: "/integrations",
  billing: "/billing",
  support: "/help",
  account: "/account",
};
export function settingsRedirect(section: string | undefined): string {
  return (section && SETTINGS_SECTIONS[section]) || "/account";
}

export function activeNavKey(pathname: string): string {
  const segs = pathname.split("/").filter(Boolean);
  const [first, second] = segs;
  if (!first) return "agent";
  if (first === "reviews") return "agent";
  if (first === "bounties") return "bounty";
  if (first === "security") return second === "config" ? "securityConfig" : "security";
  if (first === "settings") return activeNavKey(settingsRedirect(second));
  const hit = NAV_ITEMS.find((n) => n.path === `/${first}`);
  return hit ? hit.key : "agent";
}
