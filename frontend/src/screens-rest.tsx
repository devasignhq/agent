// @ts-nocheck
// Settings page (and its sub-sections)
import React from "react";
import { Icon } from "./icons";
import { api, installRedirectUrl, linearConnectUrl, type LinearTeamsView } from "./api";
import { useAuth } from "./auth-context";
import { registerPopup, closePopup } from "./popup-registry";

// ─── Settings ───────────────────────────────────────────────────────────────
const SET_SECTIONS = [
{ key: "account", name: "Account" },
{ key: "install", name: "Repository" },
{ key: "integrations", name: "Integrations" },
{ key: "billing", name: "Billing" },
{ key: "support", name: "Support" }];


const SettingsPage = ({ initialSection }) => {
  const [sec, setSec] = React.useState(initialSection || "account");
  React.useEffect(() => {
    if (initialSection) setSec(initialSection);
  }, [initialSection]);
  return (
    <div className="page" style={{ maxWidth: "none" }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-sub">acme org · admin: you</div>
        </div>
      </div>

      <div className="set-grid">
        <div className="set-nav">
          {SET_SECTIONS.map((s) =>
          <div key={s.key}
          className={`set-nav-item ${sec === s.key ? "active" : ""}`}
          onClick={() => setSec(s.key)}>{s.name}</div>
          )}
        </div>

        <div>
          {sec === "install" && <SetInstall />}
          {sec === "integrations" && <SetIntegrations />}
          {sec === "billing" && <SetBilling />}
          {sec === "support" && <SetSupport />}
          {sec === "account" && <SetAccount />}
        </div>
      </div>
    </div>);

};

// ─── Integrations ───────────────────────────────────────────────────────
const INTEGRATIONS = [
  {
    key: "linear",
    name: "Linear",
    icon: "linear",
    color: "#a48cff",
    tagline: "Sync review blockers as issues. Auto-link PRs to tickets.",
    docs: "linear.app/acme/team/ENG",
    connected: true,
    inDevelopment: false,
    meta: [
      { label: "workspace", value: "acme" },
      { label: "team",      value: "Engineering · ENG" },
      { label: "last sync", value: "4m ago" },
    ],
    events: [
      { key: "blocker",    name: "Open issue on blocker",      desc: "Reviewer flags critical → file ENG issue", on: true },
      { key: "link",       name: "Link PR ↔ ticket",            desc: "Match PR title prefix ENG-### to issue",   on: true },
      { key: "merged",     name: "Close on merge",              desc: "Mark linked issue Done when PR merges",   on: true },
    ],
  },
  {
    key: "slack",
    name: "Slack",
    icon: "slack",
    color: "#3ee07f",
    tagline: "Push review events to channels. Approve via slash command.",
    docs: "acme.slack.com",
    connected: true,
    inDevelopment: true,
    meta: [
      { label: "workspace", value: "acme.slack.com" },
      { label: "channel",   value: "#pr-reviews" },
      { label: "last event", value: "2m ago" },
    ],
    events: [
      { key: "review",   name: "PR ready for review",     desc: "Agent posts a diff summary + checks",       on: true },
      { key: "blocker",  name: "Reviewer blocker",         desc: "@ the PR author when severity ≥ high",       on: true },
      { key: "slash",    name: "Enable /devasign command", desc: "Approve, reroll, or assign from any channel", on: true },
    ],
  },
  {
    key: "discord",
    name: "Discord",
    icon: "discord",
    color: "#ff7a3d",
    tagline: "Notify your community server about review activity.",
    docs: "discord.gg/acme-builders",
    connected: false,
    inDevelopment: true,
    meta: [],
    events: [
      { key: "review",   name: "PR ready for review",  desc: "Post to #pr-reviews with diff summary",       on: true },
      { key: "merged",   name: "Merge events",         desc: "Heartbeat in #activity on PR merge",          on: false },
    ],
  },
];

const SetIntegrations = () => {
  const { user } = useAuth();
  // Hydrate from the backend so toggle state reflects real connection rows.
  const [rows, setRows] = React.useState([]); // /api/integrations
  const [state, setState] = React.useState(() =>
    Object.fromEntries(INTEGRATIONS.map(i => [i.key, {
      connected: false,
      events: Object.fromEntries(i.events.map(e => [e.key, e.on])),
      expanded: false,
    }]))
  );
  // Inline error for the Linear OAuth round-trip. Set when the popup posts
  // devasign_linear_done {ok:false}; also initialised from ?linear=error for the
  // popup-blocked fallback where the whole tab was redirected back here.
  const [linearError, setLinearError] = React.useState(
    () => new URLSearchParams(window.location.search).get("linear") === "error"
  );

  const refresh = React.useCallback(async () => {
    try {
      const list = await api.integrations();
      setRows(list);
      setState((s) => {
        const next = { ...s };
        // Reflect exactly what the backend reports: connected for each present
        // row, not-connected for the rest (so a disconnect clears the card).
        const present = new Set(list.map((r) => r.type));
        for (const key of Object.keys(next)) {
          next[key] = { ...next[key], connected: present.has(key) };
        }
        return next;
      });
    } catch {
      /* leave current state on a transient failure */
    }
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  // Linear connects via an OAuth popup; main.tsx posts devasign_linear_done when
  // the callback lands back on our origin. Close the popup, then either refresh to
  // pick up the new integration row (ok) or surface an inline error (!ok).
  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as any;
      if (!d || d.type !== "devasign_linear_done") return;
      closePopup("linear");
      if (d.ok === false) {
        setLinearError(true);
      } else {
        setLinearError(false);
        setTimeout(refresh, 400);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [refresh]);

  // Popup-blocked fallback: the callback redirected the whole tab to /?linear=error
  // (read into linearError above). Strip the marker so it doesn't linger in the URL
  // or re-trigger on a later mount.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("linear") !== "error") return;
    url.searchParams.delete("linear");
    window.history.replaceState({}, "", url.pathname + url.search);
  }, []);

  const toggle = (intKey, evKey) => setState(s => ({
    ...s,
    [intKey]: { ...s[intKey], events: { ...s[intKey].events, [evKey]: !s[intKey].events[evKey] } }
  }));
  const setExpanded = (intKey, v) => setState(s => ({ ...s, [intKey]: { ...s[intKey], expanded: v } }));
  const setConnected = async (intKey, v) => {
    if (v) {
      // Linear connects the whole workspace via OAuth, not a pasted token. Open
      // the backend authorize endpoint in a popup; on return main.tsx posts
      // devasign_linear_done and the listener above refreshes.
      if (intKey === "linear") {
        // A fresh attempt clears any prior inline error.
        setLinearError(false);
        // Linear integration is a Pro/Max feature; the backend returns 403 for
        // free users. Route them to the billing upgrade view instead of opening
        // a popup that would just error.
        if ((user?.plan || "free") === "free") {
          window.location.href = `${window.location.origin}/?billing=upgrade`;
          return;
        }
        const popup = window.open(
          linearConnectUrl,
          "devasign_linear",
          "width=920,height=780,menubar=no,toolbar=no,location=yes"
        );
        if (!popup) { window.location.href = linearConnectUrl; return; }
        registerPopup("linear", popup);
        popup.focus();
        // Fallback: if the user closes the popup before the message lands,
        // refresh anyway when it closes.
        const watch = setInterval(() => {
          if (popup.closed) { clearInterval(watch); refresh(); }
        }, 500);
        return;
      }
      // Slack / Discord: paste a bot token (+ channel).
      const token = prompt(
        intKey === "slack" ? "Slack bot token (xoxb-…)" : "Discord bot token"
      );
      if (!token) return;
      const channel =
        intKey === "slack" ? (prompt("Channel to broadcast verdicts to (e.g. #pr-reviews)") || "")
        : intKey === "discord" ? (prompt("Discord channel ID") || "")
        : "";
      try {
        const created = await api.addIntegration({
          type: intKey,
          tokens: { botToken: token },
          workspaceMeta: channel
            ? (intKey === "slack" ? { channel } : { channelId: channel })
            : {},
        });
        setRows((rs) => [...rs, { id: created.id, type: intKey, workspaceMeta: {}, createdAt: Date.now() }]);
        setState(s => ({ ...s, [intKey]: { ...s[intKey], connected: true, expanded: true } }));
      } catch (err) {
        alert(`Connect failed: ${err.message || err}`);
      }
    } else {
      const row = rows.find((r) => r.type === intKey);
      if (row) {
        try {
          await api.removeIntegration(row.id);
          setRows((rs) => rs.filter((r) => r.id !== row.id));
        } catch (err) {
          alert(`Disconnect failed: ${err.message || err}`);
          return;
        }
      }
      setState(s => ({ ...s, [intKey]: { ...s[intKey], connected: false, expanded: false } }));
    }
  };

  const connectedCount = INTEGRATIONS.filter(i => !i.inDevelopment && state[i.key].connected).length;

  // Show the real connected workspace for Linear (from the backend row) instead
  // of the placeholder meta baked into INTEGRATIONS.
  const metaFor = (i) => {
    if (i.key === "linear") {
      const r = rows.find((x) => x.type === "linear");
      const name = r?.workspaceMeta?.workspaceName || r?.workspaceMeta?.urlKey;
      if (name) {
        return [
          { label: "workspace", value: name },
          ...(r.workspaceMeta.urlKey ? [{ label: "url key", value: r.workspaceMeta.urlKey }] : []),
        ];
      }
    }
    return i.meta;
  };

  return (
    <div className="col gap-5">
      {/* Summary strip */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Connected apps</h3>
          <span className="mono mute" style={{ fontSize: 11 }}>
            {connectedCount} of {INTEGRATIONS.length} active · acme org · last event 2m ago
          </span>
        </div>
        <div className="card-body">
          <div className="int-summary">
            {INTEGRATIONS.map(i => {
              const dev = i.inDevelopment;
              const isOn = !dev && state[i.key].connected;
              return (
                <div key={i.key} className={`int-summary-cell ${isOn ? "on" : "off"}`} style={dev ? { opacity: 0.55 } : undefined}>
                  <div className="int-mark" style={{ color: isOn ? i.color : "var(--fg-mute)" }}>
                    <Icon name={i.icon} size={14}/>
                  </div>
                  <div className="mono int-summary-name">{i.name}</div>
                  {dev
                    ? <span className="pill" style={{ color: "var(--fg-mute)" }}><i className="dot"></i> in dev</span>
                    : <span className={`pill ${isOn ? "ok" : ""}`} style={!isOn ? { color: "var(--fg-mute)" } : {}}>
                        <i className="dot"></i>{isOn ? "connected" : "off"}
                      </span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Per-integration cards */}
      {INTEGRATIONS.map(i => {
        const s = state[i.key];
        const dev = i.inDevelopment;
        const enabledCount = Object.values(s.events).filter(Boolean).length;
        return (
          <div key={i.key} className="card" style={dev ? { opacity: 0.6 } : undefined}>
            <div className="card-head int-head">
              <div className="int-id">
                <div className="int-logo" style={{ color: !dev && s.connected ? i.color : "var(--fg-mute)" }}>
                  <Icon name={i.icon} size={20}/>
                </div>
                <div className="int-id-body">
                  <div className="int-name-row">
                    <span className="int-name">{i.name}</span>
                    {dev
                      ? <span className="pill" style={{ color: "var(--fg-mute)" }}><i className="dot"></i> In development</span>
                      : s.connected
                      ? <span className="pill ok"><i className="dot"></i> connected</span>
                      : <span className="pill" style={{ color: "var(--fg-mute)" }}><i className="dot"></i> not connected</span>}
                  </div>
                  <div className="int-tagline">{i.tagline}</div>
                </div>
              </div>
              <div className="int-head-actions">
                {dev ? (
                  <span className="mono mute" style={{ fontSize: 11 }}>Coming soon</span>
                ) : s.connected ? (
                  <>
                    <button className="btn ghost sm" onClick={() => setExpanded(i.key, !s.expanded)}>
                      <span className={`chev ${s.expanded ? "open" : ""}`}><Icon name="chevron-d" size={11}/></span>
                      <span style={{ marginLeft: 6 }}>{s.expanded ? "Collapse" : "Configure"}</span>
                    </button>
                  </>
                ) : (
                  <button className="btn primary sm" onClick={() => setConnected(i.key, true)}>
                    <Icon name="link" size={12}/> Connect {i.name}
                  </button>
                )}
              </div>
            </div>

            {i.key === "linear" && linearError && !s.connected && (
              <div className="card-body">
                <div
                  className="gh-installed-banner"
                  style={{ borderColor: "rgba(255,90,95,0.35)", background: "rgba(255,90,95,0.06)" }}
                >
                  <div className="gh-installed-icon" style={{ background: "var(--danger)", color: "#2a0b0c" }}>
                    <Icon name="warn" size={12} />
                  </div>
                  <div className="flex-1">
                    <div className="mono" style={{ fontSize: 12, color: "var(--fg)" }}>
                      Couldn't connect Linear
                    </div>
                    <div className="mute mono" style={{ fontSize: 11, marginTop: 1 }}>
                      The authorization didn't complete. Please click Connect Linear to try again.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {!dev && s.connected && s.expanded && (
              <div className="card-body int-body">
                {/* Connection meta — single inline strip */}
                <div className="int-meta-strip">
                  {metaFor(i).map(m => (
                    <span key={m.label} className="int-meta-chip">
                      <span className="int-meta-label">{m.label}</span>
                      <span className="int-meta-value">{m.value}</span>
                    </span>
                  ))}
                  <span className="int-meta-chip">
                    <span className="int-meta-label">events</span>
                    <span className="int-meta-value">
                      <span style={{ color: "var(--accent)" }}>{enabledCount}</span>
                      <span className="mute">/{i.events.length}</span>
                    </span>
                  </span>
                  <span className="int-meta-spacer"></span>
                  <a className="int-docs-link mono" href="#" onClick={(e) => e.preventDefault()}>
                    {i.docs} <Icon name="external" size={10}/>
                  </a>
                </div>

                {/* Event subscriptions — compact single-line rows */}
                <div className="int-events">
                  {i.events.map(e => (
                    <label key={e.key} className="int-event-row">
                      <div
                        className={`tog sm ${s.events[e.key] ? "on" : ""}`}
                        onClick={() => toggle(i.key, e.key)}
                      ></div>
                      <span className="int-event-name">{e.name}</span>
                      <span className="int-event-desc">{e.desc}</span>
                    </label>
                  ))}
                </div>

                {/* Footer actions */}
                <div className="int-foot">
                  <button
                    className="btn ghost sm danger"
                    onClick={() => setConnected(i.key, false)}
                  >Disconnect</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const SetInstall = () => {
  // Live installs + repos. Refreshes on mount, when an install message arrives
  // from the popup-handshake, and once after the user opens a popup so we
  // catch the round-trip even if the user dismisses the popup themselves.
  const [installs, setInstalls] = React.useState<any[]>([]);
  const [repos, setRepos] = React.useState<any[]>([]);
  const [linear, setLinear] = React.useState<LinearTeamsView | null>(null);
  // Two-phase load: phase 1 paints the local DB snapshot in one LAN round-
  // trip (the `?fast=1` variant skips awaiting the GitHub reconcile); phase 2
  // calls the default endpoint to pick up anything the background reconcile
  // turned up (missed webhooks, popup-handshake races, etc). The page never
  // shows an empty repo list while a network round-trip to GitHub is pending.
  const refresh = React.useCallback(async () => {
    try {
      const [is, rs] = await Promise.all([api.installationsFast(), api.repositories()]);
      setInstalls(is);
      setRepos(rs);
    } catch {
      /* phase 2 will retry */
    }
    try {
      const reconciled = await api.installations();
      setInstalls(reconciled);
      // Reconcile may have inserted new Repository rows via
      // /installation/repositories; refresh the repos slice too.
      setRepos(await api.repositories());
    } catch {
      /* keep phase-1 data on screen */
    }
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  // Linear workspace teams for the section below the GitHub App card. Fetched live
  // from the backend (token stays server-side); refreshed on connect.
  const refreshLinear = React.useCallback(async () => {
    try { setLinear(await api.linearTeams()); } catch { /* keep prior state */ }
  }, []);
  React.useEffect(() => { refreshLinear(); }, [refreshLinear]);

  // Same popup-completion message that onboarding listens for.
  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d: any = e.data;
      if (d && d.type === "devasign_install_done") {
        // Give the link round-trip a beat to finish, then refresh.
        setTimeout(refresh, 400);
      } else if (d && d.type === "devasign_linear_done") {
        setTimeout(refreshLinear, 400);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [refresh, refreshLinear]);

  const launchConfigure = () => {
    const popup = window.open(
      installRedirectUrl,
      "devasign_install",
      "width=920,height=780,menubar=no,toolbar=no,location=yes"
    );
    if (!popup) {
      window.location.href = installRedirectUrl;
      return;
    }
    registerPopup("install", popup);
    popup.focus();
    // Recover the install regardless of popup outcome — when it closes, the
    // backend's reconcile (on GET /api/installations) catches anything new.
    const watch = setInterval(() => {
      if (popup.closed) { clearInterval(watch); refresh(); }
    }, 500);
  };

  // Group repos under their installation for the connected-repos list.
  const installRows = React.useMemo(() => {
    const byInstall = new Map<string, { inst: any; repos: any[] }>();
    for (const i of installs) byInstall.set(i.id, { inst: i, repos: [] });
    for (const r of repos) {
      const e = byInstall.get(r.installationId);
      if (e) e.repos.push(r);
    }
    // Only surface installs that actually have ≥1 installed repo. An install
    // with no repos is just an authorized account (the "user authentication"
    // case), not a repo installation — don't show or count it here.
    return [...byInstall.values()].filter(({ repos }) => repos.length > 0);
  }, [installs, repos]);

  return (
    <div className="flex gap-5">
      <div className="card" style={{ flex: "1 1 0", minWidth: 0 }}>
        <div className="card-head">
          <h3 className="card-title">GitHub App</h3>
          {installRows.length > 0
            ? <span className="pill ok"><i className="dot"></i> {installRows.length} install{installRows.length === 1 ? "" : "s"}</span>
            : <span className="pill"><i className="dot"></i> not installed</span>}
        </div>
        <div className="card-body">
          <div className="mute" style={{ fontSize: 12, marginBottom: 12 }}>
            {installRows.length > 0
              ? "Manage Repos and Permissions on GitHub"
              : "Install the DevAsign GitHub App on at least one account or org to start reviewing PRs."}
          </div>

          {installRows.length > 0 && (
            <ul className="gh-repo-list" style={{ marginBottom: 14 }}>
              {installRows.flatMap(({ repos: rs }) => rs).map((r) => (
                <li key={r.id} className="gh-repo-row">
                  <Icon name="git" size={11} color="var(--fg-faint)" />
                  <span className="mono gh-repo-name">{r.owner}/{r.name}</span>
                  <span className="gh-repo-meta mono">{r.defaultBranch}</span>
                  <span className="flex-1"></span>
                  <span className="gh-repo-vis mono private">private</span>
                </li>
              ))}
            </ul>
          )}

          <div>
            <button className="btn primary" onClick={launchConfigure}>
              <Icon name="external" size={11} /> Configure on GitHub
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ flex: "1 1 0", minWidth: 0 }}>
        <div className="card-head">
          <h3 className="card-title">Linear workspace</h3>
          {linear?.connected
            ? <span className="pill ok"><i className="dot"></i> connected</span>
            : <span className="pill"><i className="dot"></i> not connected</span>}
        </div>
        <div className="card-body">
          <div className="mute" style={{ fontSize: 12, marginBottom: 12 }}>
            {linear?.connected
              ? "Teams in the Linear workspace you connected DevAsign to."
              : "Connect Linear under Settings → Integrations to list workspace teams."}
          </div>

          {linear?.connected && linear.teams.length > 0 && (
            <div className="gh-accounts">
              <div className="gh-account">
                <div className="gh-account-head">
                  <div className="gh-account-avatar personal">
                    {String(linear.workspace || "?").charAt(0).toUpperCase()}
                  </div>
                  <span className="mono gh-account-name">{linear.workspace || "workspace"}</span>
                  <span className="gh-account-kind mono">linear</span>
                  <span className="flex-1"></span>
                  <span className="mono gh-account-count">
                    {linear.teams.length} team{linear.teams.length === 1 ? "" : "s"}
                  </span>
                </div>
                <ul className="gh-repo-list">
                  {linear.teams.map((t) => (
                    <li key={t.id} className="gh-repo-row">
                      <Icon name="linear" size={11} color="var(--fg-faint)" />
                      <span className="mono gh-repo-name">{t.key}</span>
                      <span className="gh-repo-meta mono">{t.name}</span>
                      <span className="flex-1"></span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {linear?.connected && linear.teams.length === 0 && (
            <div className="mute" style={{ fontSize: 12 }}>
              No teams found in this workspace.
            </div>
          )}
        </div>
      </div>

    </div>);

};

const PLANS = [
{
  id: "free", name: "Free", icon: "terminal",
  tagline: "Automated review on public repos",
  price: "$0", unit: "/ forever",
  features: ["Public repositories", "Standard model (Haiku)", "10 PR reviews / month"],
},
{
  id: "pro", name: "Pro", icon: "spark", featured: true,
  tagline: "For developers shipping private code",
  price: "$15", unit: "USD / month", reassure: "14-day free trial · cancel anytime",
  features: ["Private + public repositories", "Frontier model (Opus)", "50 PR reviews / month", "Linear sync"],
},
{
  id: "max", name: "Max", icon: "brain",
  tagline: "For teams reviewing at scale",
  price: "$45", unit: "USD / month", reassure: "14-day free trial · cancel anytime",
  features: ["Private + public repositories", "Frontier model (Opus)", "Unlimited PR reviews", "Linear sync"],
}];

const planLabel = (p) => (p === "max" ? "Max" : p === "pro" ? "Pro" : "Free");
const PLAN_RANK = { free: 0, pro: 1, max: 2 };
// A plan card's CTA relative to the user's current plan — null when it IS the current plan.
const ctaLabel = (target, current) =>
  target === current ? null : `${PLAN_RANK[target] > PLAN_RANK[current] ? "Upgrade" : "Downgrade"} to ${planLabel(target)}`;

const SetBilling = () => {
  const { user } = useAuth();
  const [view, setView] = React.useState(null); // SubscriptionView | null (GET /billing/subscription)
  const [busy, setBusy] = React.useState(null); // plan id | "portal" | "cancel" | "switch" | "revert" | null
  const [err, setErr] = React.useState(null);
  const [switchTo, setSwitchTo] = React.useState(null); // { plan, upgrade } while confirming a switch

  const refresh = React.useCallback(() => api.subscription().then(setView).catch(() => {}), []);
  React.useEffect(() => { refresh(); }, [refresh]);

  // effectivePlan reflects any lapse-downgrade; `purchased` is what they bought.
  const effective = view?.effectivePlan || user?.plan || "free";
  const purchased = view?.subscription?.plan || effective;
  const status = view?.subscription?.status || null;
  const lapsed = purchased !== "free" && effective === "free"; // paid but downgraded by Stripe
  const usage =
    view == null
      ? "…"
      : view.reviewLimit == null
      ? `${view.reviewsUsed} reviews this month · unlimited`
      : `${view.reviewsUsed} / ${view.reviewLimit} PR reviews this month`;
  const renew = view?.subscription?.currentPeriodEnd
    ? new Date(view.subscription.currentPeriodEnd).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : null;
  const renewLabel = status === "trialing" ? "trial ends" : "renews";

  const startCheckout = async (plan) => {
    setErr(null);
    setBusy(plan);
    try {
      const { url } = await api.checkout(plan);
      window.location.href = url;
    } catch (e) {
      setErr(e?.message || "Couldn't start checkout. Is billing configured?");
      setBusy(null);
    }
  };
  const openPortal = async () => {
    setErr(null);
    setBusy("portal");
    try {
      const { url } = await api.portal();
      window.location.href = url;
    } catch (e) {
      setErr(e?.message || "Couldn't open the billing portal.");
      setBusy(null);
    }
  };
  // Deep-links straight into Stripe's cancel flow; on confirm it auto-redirects
  // back to /?billing=canceled (handled in app.tsx → opens this page).
  const cancelSub = async () => {
    setErr(null);
    setBusy("cancel");
    try {
      const { url } = await api.portal({ cancel: true });
      window.location.href = url;
    } catch (e) {
      setErr(e?.message || "Couldn't open the cancel flow.");
      setBusy(null);
    }
  };
  const pendingCancel = !!view?.subscription?.cancelAtPeriodEnd;
  const pendingPlan = view?.subscription?.pendingPlan || null;

  // Plan-card CTA click: free→checkout (new sub), paid↔paid→confirm panel, →free→cancel.
  const onCardCta = (target) => {
    setErr(null);
    if (effective === "free") return void startCheckout(target);
    if (target === "free") return void cancelSub();
    setSwitchTo({ plan: target, upgrade: PLAN_RANK[target] > PLAN_RANK[effective] });
  };
  const doChangePlan = async (plan, immediate) => {
    setErr(null);
    setBusy("switch");
    try {
      await api.changePlan(plan, { immediate });
      setSwitchTo(null);
      await refresh();
    } catch (e) {
      setErr(e?.message || "Couldn't change plan.");
    } finally {
      setBusy(null);
    }
  };
  const revertScheduled = async () => {
    setErr(null);
    setBusy("revert");
    try {
      await api.cancelScheduledChange();
      await refresh();
    } catch (e) {
      setErr(e?.message || "Couldn't revert the scheduled switch.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="col gap-5">
      {lapsed &&
      <div className="card" style={{ borderColor: "var(--danger)" }}>
        <div className="card-body flex justify-between items-center" style={{ gap: 16, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="mono" style={{ fontSize: 13, color: "var(--danger)" }}>
              Your {planLabel(purchased)} plan lapsed — you're on Free
            </div>
            <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
              {status === "past_due" ? "Your last payment failed." : "Your subscription ended."} Update your
              payment method to restore {planLabel(purchased)} (private repos, Opus reviews, Linear sync).
            </div>
          </div>
          <button className="btn" disabled={busy === "portal"} onClick={openPortal}>
            {busy === "portal" ? "Opening…" : "Update payment"}
          </button>
        </div>
      </div>
      }

      {pendingPlan &&
      <div className="card" style={{ borderColor: "var(--accent)" }}>
        <div className="card-body flex justify-between items-center" style={{ gap: 16, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="mono" style={{ fontSize: 13 }}>
              Switching to {planLabel(pendingPlan)}{renew ? ` on ${renew}` : ""}
            </div>
            <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
              You keep {planLabel(effective)} until then.
            </div>
          </div>
          <button className="btn ghost" disabled={busy === "revert"} onClick={revertScheduled}>
            {busy === "revert" ? "…" : `Keep ${planLabel(effective)}`}
          </button>
        </div>
      </div>
      }

      <div>
        <div className="flex justify-between items-center" style={{ gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            <h3 className="card-title" style={{ marginBottom: 5 }}>Plans</h3>
            <div className="mute mono" style={{ fontSize: 12 }}>
              {usage}{renew ? ` · ${renewLabel} ${renew}` : ""}
            </div>
          </div>
          <span className="pill purple"><i className="dot"></i> {planLabel(effective)} plan</span>
        </div>

        <div className="plan-grid">
          {PLANS.map((p) => {
            const isCurrent = p.id === effective;
            const cta = ctaLabel(p.id, effective);
            const upgrade = PLAN_RANK[p.id] > PLAN_RANK[effective];
            return (
              <div key={p.id} className={`plan${p.featured ? " featured" : ""}${isCurrent ? " current" : ""}`}>
                {isCurrent
                  ? <span className="pill ok plan-badge"><i className="dot"></i> current</span>
                  : p.featured
                  ? <span className="pill purple plan-badge">popular</span>
                  : null}

                <div className="plan-icon"><Icon name={p.icon} size={18} /></div>
                <div className="plan-name">{p.name}</div>
                <div className="plan-tag">{p.tagline}</div>

                <div className="plan-price">
                  <b>{p.price}</b><span className="plan-unit">{p.unit}</span>
                </div>
                <div className="plan-note">{p.reassure || ""}</div>

                {isCurrent
                  ? (p.id === "free"
                    ? <button className="btn lg ghost plan-cta" disabled>Current plan</button>
                    : <button className="btn lg ghost plan-cta" disabled={busy === "portal"} onClick={openPortal}>
                        {busy === "portal" ? "Opening…" : "Manage plan"}
                      </button>)
                  : <button className={`btn lg plan-cta ${upgrade ? "primary" : "ghost"}`}
                    disabled={busy === p.id || busy === "switch"} onClick={() => onCardCta(p.id)}>
                      {busy === p.id ? "Starting…" : cta}
                    </button>}

                <ul className="plan-feats">
                  {p.features.map((f) =>
                    <li key={f} className="plan-feat"><Icon name="check" size={13} /><span>{f}</span></li>)}
                </ul>
              </div>);
          })}
        </div>
        {err && <div className="mute" style={{ color: "var(--danger)", fontSize: 12, marginTop: 12 }}>{err}</div>}
      </div>

      {switchTo &&
      <div className="card" style={{ borderColor: "var(--accent)" }}>
        <div className="card-body col gap-3">
          {switchTo.upgrade ? (
            <>
              <div className="mono" style={{ fontSize: 13 }}>Upgrade to {planLabel(switchTo.plan)} now?</div>
              <div className="mute" style={{ fontSize: 12 }}>
                Takes effect immediately
                {status === "trialing" ? " — no charge until your trial ends." : ", with a prorated charge today."}
              </div>
              <div className="flex gap-2">
                <button className="btn" disabled={busy === "switch"} onClick={() => doChangePlan(switchTo.plan, true)}>
                  {busy === "switch" ? "Switching…" : `Upgrade to ${planLabel(switchTo.plan)}`}
                </button>
                <button className="btn ghost" disabled={busy === "switch"} onClick={() => setSwitchTo(null)}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <div className="mono" style={{ fontSize: 13 }}>Switch to {planLabel(switchTo.plan)}</div>
              <div className="mute" style={{ fontSize: 12 }}>
                Takes effect {renew ? `on ${renew}` : "next period"} — you keep {planLabel(effective)} until then.
                Or switch now and we'll credit the prorated difference.
              </div>
              <div className="flex gap-2">
                <button className="btn" disabled={busy === "switch"} onClick={() => doChangePlan(switchTo.plan, false)}>
                  {busy === "switch" ? "Scheduling…" : (renew ? `Switch on ${renew}` : "Switch next period")}
                </button>
                <button className="btn ghost" disabled={busy === "switch"} onClick={() => doChangePlan(switchTo.plan, true)}>
                  Switch immediately
                </button>
                <button className="btn ghost" disabled={busy === "switch"} onClick={() => setSwitchTo(null)}>Cancel</button>
              </div>
            </>
          )}
        </div>
      </div>
      }

      {effective !== "free" &&
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Subscription</h3>
          {renew && <span className="mute mono" style={{ fontSize: 11 }}>
            {pendingCancel ? "cancels" : renewLabel} {renew}
          </span>}
        </div>
        <div className="card-body flex justify-between items-center" style={{ gap: 16, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="mono" style={{ fontSize: 13 }}>{planLabel(effective)} plan · billed monthly</div>
            <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
              {pendingCancel
                ? `Set to cancel${renew ? ` on ${renew}` : ""} — you'll drop to Free then. Reopen the portal to keep it.`
                : "Update your card or view invoices in the Stripe portal. Cancelling sends you to Stripe to confirm, then back here."}
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn ghost" disabled={busy === "portal"} onClick={openPortal}>
              {busy === "portal" ? "Opening…" : "Manage subscription"}
            </button>
            {!pendingCancel &&
            <button className="btn ghost danger" disabled={busy === "cancel"} onClick={cancelSub}>
              {busy === "cancel" ? "Opening…" : "Cancel subscription"}
            </button>}
          </div>
        </div>
      </div>
      }
    </div>);
};


// ─── Account · delete + export ──────────────────────────────────────────
const SetAccount = () => {
  const { user } = useAuth();
  const [step, setStep] = React.useState("idle"); // idle | confirm | done
  const [confirmText, setConfirmText] = React.useState("");
  const [confirmName, setConfirmName] = React.useState("");
  const REQUIRED = "delete my account";

  // Both factors must match: the user's own username AND the literal phrase. The
  // non-empty githubLogin guard keeps the button disabled when both fields are blank.
  const nameOk = !!user?.githubLogin && confirmName.trim().toLowerCase() === user.githubLogin.toLowerCase();
  const phraseOk = confirmText.trim().toLowerCase() === REQUIRED;

  const memberSince = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : "—";

  return (
    <div className="col gap-5">
      <div className="card">
        <div className="card-head"><h3 className="card-title">Profile</h3></div>
        <div className="card-body">
          <div className="kv-grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 0 }}>
            <div className="kv">
              <div className="kv-k">github</div>
              <div className="kv-v mono" style={{ fontSize: 13 }}>@{user?.githubLogin || "—"}</div>
            </div>
            <div className="kv">
              <div className="kv-k">email</div>
              <div className="kv-v mono" style={{ fontSize: 13 }}>{user?.email || "—"}</div>
            </div>
            <div className="kv">
              <div className="kv-k">plan</div>
              <div className="kv-v mono" style={{ fontSize: 13 }}>{user?.plan || "free"}</div>
            </div>
            <div className="kv">
              <div className="kv-k">member since</div>
              <div className="kv-v mono" style={{ fontSize: 13 }}>{memberSince}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ borderColor: "color-mix(in oklch, var(--danger) 35%, var(--line))" }}>
        <div className="card-head">
          <h3 className="card-title" style={{ color: "var(--danger)" }}>Danger zone</h3>
          <span className="pill danger"><i className="dot"></i> irreversible</span>
        </div>
        <div className="card-body">
          {step === "idle" &&
          <div className="flex justify-between items-center" style={{ gap: 16, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono" style={{ fontSize: 13 }}>Delete your account</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
                Permanently removes your profile, agent settings, review history, and connected GitHub installs.
              </div>
            </div>
            <button className="btn danger" onClick={() => setStep("confirm")}>Delete account…</button>
          </div>
          }

          {step === "confirm" &&
          <div className="col gap-3">
            <div className="mono" style={{ fontSize: 13, color: "var(--danger)" }}>This cannot be undone.</div>
            <div className="mute" style={{ fontSize: 12 }}>
              Type your username <span className="mono" style={{ color: "var(--fg)" }}>{user?.githubLogin || "—"}</span> to confirm.
            </div>
            <input
            className="input"
            placeholder={user?.githubLogin || "username"}
            value={confirmName}
            autoComplete="off"
            onChange={(e) => setConfirmName(e.target.value)}
            style={{ maxWidth: 360, fontFamily: "var(--mono)" }} />
            <div className="mute" style={{ fontSize: 12 }}>
              Then type <span className="mono" style={{ color: "var(--fg)" }}>"{REQUIRED}"</span> to confirm.
            </div>
            <input
            className="input"
            placeholder={REQUIRED}
            value={confirmText}
            autoComplete="off"
            onChange={(e) => setConfirmText(e.target.value)}
            style={{ maxWidth: 360, fontFamily: "var(--mono)" }} />
            <div className="flex gap-2">
              <button className="btn" onClick={() => {setStep("idle");setConfirmText("");setConfirmName("");}}>Cancel</button>
              <button
              className="btn danger"
              disabled={!nameOk || !phraseOk}
              onClick={() => setStep("done")}>
                Permanently delete account
              </button>
            </div>
          </div>
          }

          {step === "done" &&
          <div className="col gap-2">
            <div className="flex items-center gap-2">
              <Icon name="check" size={14} color="var(--accent)" />
              <span className="mono" style={{ fontSize: 13 }}>Account scheduled for deletion</span>
            </div>
            <div className="mute" style={{ fontSize: 12 }}>
              Your data will be purged within 30 days. We've emailed maya@acme.dev with details and a
              link to cancel if this was a mistake.
            </div>
          </div>
          }
        </div>
      </div>
    </div>);
};


const SUPPORT_CHANNELS = [
  { name: "Documentation", desc: "Full docs · API reference · self-serve guides", cta: "devasign.com/docs", href: "https://devasign.com/docs", i: "doc" },
  { name: "Discord community", desc: "Join the community · #help channel", cta: "Join Discord", href: "https://discord.com/invite/GtvqA4UPwT", i: "discord" },
  {
    name: "Email support", i: "send",
    desc: <>Send us an email at <a className="mono" style={{ color: "var(--accent)", textDecoration: "none" }} href="mailto:bethel@devasign.com">bethel@devasign.com</a> and we'll reply within an hour.</>,
  },
];

const SetSupport = () =>
<div className="col gap-5">
    <div className="card">
      <div className="card-head"><h3 className="card-title">Support channels</h3></div>
      <div>
        {SUPPORT_CHANNELS.map((s) =>
      <div key={s.name} className="row" style={{ display: "grid", gridTemplateColumns: "40px 1fr auto", gap: 14, height: 64 }}>
            <div className="integ-icon"><Icon name={s.i} size={14} /></div>
            <div>
              <div className="mono" style={{ fontSize: 13 }}>{s.name}</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 2 }}>{s.desc}</div>
            </div>
            {s.href &&
            <a className="btn" href={s.href} target="_blank" rel="noopener noreferrer">{s.cta} <Icon name="external" size={11} /></a>}
          </div>
      )}
      </div>
    </div>
  </div>;

export { SettingsPage };
