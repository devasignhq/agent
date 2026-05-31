// @ts-nocheck
// Settings page (and its sub-sections)
import React from "react";
import { Icon } from "./icons";
import { api, installRedirectUrl } from "./api";
import { useAuth } from "./auth-context";
import { registerPopup } from "./popup-registry";

// ─── Settings ───────────────────────────────────────────────────────────────
const SET_SECTIONS = [
{ key: "account", name: "Account" },
{ key: "install", name: "Installation" },
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
    meta: [],
    events: [
      { key: "review",   name: "PR ready for review",  desc: "Post to #pr-reviews with diff summary",       on: true },
      { key: "merged",   name: "Merge events",         desc: "Heartbeat in #activity on PR merge",          on: false },
    ],
  },
];

const SetIntegrations = () => {
  // Hydrate from the backend so toggle state reflects real connection rows.
  const [rows, setRows] = React.useState([]); // /api/integrations
  const [state, setState] = React.useState(() =>
    Object.fromEntries(INTEGRATIONS.map(i => [i.key, {
      connected: false,
      events: Object.fromEntries(i.events.map(e => [e.key, e.on])),
      expanded: false,
    }]))
  );

  React.useEffect(() => {
    api.integrations().then((list) => {
      setRows(list);
      setState((s) => {
        const next = { ...s };
        for (const r of list) {
          if (next[r.type]) next[r.type] = { ...next[r.type], connected: true, expanded: true };
        }
        return next;
      });
    }).catch(() => {});
  }, []);

  const toggle = (intKey, evKey) => setState(s => ({
    ...s,
    [intKey]: { ...s[intKey], events: { ...s[intKey].events, [evKey]: !s[intKey].events[evKey] } }
  }));
  const setExpanded = (intKey, v) => setState(s => ({ ...s, [intKey]: { ...s[intKey], expanded: v } }));
  const setConnected = async (intKey, v) => {
    if (v) {
      const token = prompt(
        intKey === "slack"   ? "Slack bot token (xoxb-…)" :
        intKey === "linear"  ? "Linear API key (lin_api_…)" :
                               "Discord bot token"
      );
      if (!token) return;
      const channel =
        intKey === "slack" ? (prompt("Channel to broadcast verdicts to (e.g. #pr-reviews)") || "")
        : intKey === "discord" ? (prompt("Discord channel ID") || "")
        : "";
      try {
        const created = await api.addIntegration({
          type: intKey,
          tokens: intKey === "linear" ? { apiKey: token } : { botToken: token },
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

  const connectedCount = Object.values(state).filter(s => s.connected).length;

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
              const isOn = state[i.key].connected;
              return (
                <div key={i.key} className={`int-summary-cell ${isOn ? "on" : "off"}`}>
                  <div className="int-mark" style={{ color: isOn ? i.color : "var(--fg-mute)" }}>
                    <Icon name={i.icon} size={14}/>
                  </div>
                  <div className="mono int-summary-name">{i.name}</div>
                  <span className={`pill ${isOn ? "ok" : ""}`} style={!isOn ? { color: "var(--fg-mute)" } : {}}>
                    <i className="dot"></i>{isOn ? "connected" : "off"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Per-integration cards */}
      {INTEGRATIONS.map(i => {
        const s = state[i.key];
        const enabledCount = Object.values(s.events).filter(Boolean).length;
        return (
          <div key={i.key} className="card">
            <div className="card-head int-head">
              <div className="int-id">
                <div className="int-logo" style={{ color: s.connected ? i.color : "var(--fg-mute)" }}>
                  <Icon name={i.icon} size={20}/>
                </div>
                <div className="int-id-body">
                  <div className="int-name-row">
                    <span className="int-name">{i.name}</span>
                    {s.connected
                      ? <span className="pill ok"><i className="dot"></i> connected</span>
                      : <span className="pill" style={{ color: "var(--fg-mute)" }}><i className="dot"></i> not connected</span>}
                  </div>
                  <div className="int-tagline">{i.tagline}</div>
                </div>
              </div>
              <div className="int-head-actions">
                {s.connected ? (
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

            {s.connected && s.expanded && (
              <div className="card-body int-body">
                {/* Connection meta — single inline strip */}
                <div className="int-meta-strip">
                  {i.meta.map(m => (
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

      {/* Footer: explore more */}
      <div className="card int-more">
        <div className="card-body">
          <div className="flex justify-between items-center" style={{ gap: 12, flexWrap: "wrap" }}>
            <div>
              <div className="mono" style={{ fontSize: 13 }}>Need another integration?</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
                Jira, Notion, PagerDuty, and 18 more available via the webhook bridge.
              </div>
            </div>
            <div className="flex gap-2">
              <button className="btn ghost sm"><Icon name="globe" size={11}/> Browse directory</button>
              <button className="btn sm"><Icon name="code" size={11}/> Build a webhook</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const SetInstall = () => {
  // Live installs + repos. Refreshes on mount, when an install message arrives
  // from the popup-handshake, and once after the user opens a popup so we
  // catch the round-trip even if the user dismisses the popup themselves.
  const [installs, setInstalls] = React.useState<any[]>([]);
  const [repos, setRepos] = React.useState<any[]>([]);
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

  // Same popup-completion message that onboarding listens for.
  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d: any = e.data;
      if (d && d.type === "devasign_install_done") {
        // Give the link round-trip a beat to finish, then refresh.
        setTimeout(refresh, 400);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [refresh]);

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
    return [...byInstall.values()];
  }, [installs, repos]);

  return (
    <div className="col gap-5">
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">GitHub App</h3>
          {installs.length > 0
            ? <span className="pill ok"><i className="dot"></i> {installs.length} install{installs.length === 1 ? "" : "s"}</span>
            : <span className="pill"><i className="dot"></i> not installed</span>}
        </div>
        <div className="card-body">
          <div className="mute" style={{ fontSize: 12, marginBottom: 12 }}>
            {installs.length > 0
              ? `Connected to ${installs.map((i) => i.accountLogin).join(", ")}. Manage repos and permissions on GitHub — changes sync back instantly.`
              : "Install the DevAsign GitHub App on at least one account or org to start reviewing PRs."}
          </div>

          {installRows.length > 0 && (
            <div className="gh-accounts" style={{ marginBottom: 14 }}>
              {installRows.map(({ inst, repos: rs }) => (
                <div key={inst.id} className="gh-account">
                  <div className="gh-account-head">
                    <div className="gh-account-avatar personal">
                      {String(inst.accountLogin || "?").charAt(0).toUpperCase()}
                    </div>
                    <span className="mono gh-account-name">{inst.accountLogin}</span>
                    <span className="gh-account-kind mono">install · #{inst.installationId}</span>
                    <span className="flex-1"></span>
                    <span className="mono gh-account-count">{rs.length} repo{rs.length === 1 ? "" : "s"}</span>
                  </div>
                  <ul className="gh-repo-list">
                    {rs.length === 0 && (
                      <li className="gh-repo-row mute mono" style={{ fontSize: 11 }}>
                        No repositories granted yet — pick repos on GitHub.
                      </li>
                    )}
                    {rs.map((r) => (
                      <li key={r.id} className="gh-repo-row">
                        <Icon name="git" size={11} color="var(--fg-faint)" />
                        <span className="mono gh-repo-name">{r.owner}/{r.name}</span>
                        <span className="gh-repo-meta mono">
                          {r.defaultBranch} · {r.reviewsEnabled ? "reviews on" : "reviews off"}
                        </span>
                        <span className="flex-1"></span>
                        <span className="gh-repo-vis mono private">private</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <div className="code-block">
            <code>{installRedirectUrl.replace(/^https?:\/\//, "")}</code>
            <button className="btn sm" onClick={launchConfigure}>
              <Icon name="external" size={11} /> Configure on GitHub
            </button>
          </div>
        </div>
      </div>

    </div>);

};

const PLANS = [
{ id: "free", name: "Free", tagline: "For maintainers of public repos", price: "$0", cadence: "/ free forever", features: "Public repos only" },
{ id: "pro", name: "Pro", tagline: "For private repos & small teams", price: "$25", cadence: "/ month", features: "Private repos · Limited PR review", cta: "Get Pro Plan" },
{ id: "max", name: "Max", tagline: "For shipping teams that review at velocity", price: "$100", cadence: "/ month", features: "Unlimited PR reviews · Priority queue", cta: "Get Max Plan" }];

const INVOICES = [
{ id: "inv-2026-05", date: "May 14, 2026", amount: "$25.00", status: "paid" },
{ id: "inv-2026-04", date: "Apr 14, 2026", amount: "$25.00", status: "paid" },
{ id: "inv-2026-03", date: "Mar 14, 2026", amount: "$25.00", status: "paid" }];


const SetBilling = () => {
  const { user } = useAuth();
  const [cancelStep, setCancelStep] = React.useState("idle"); // idle | confirm | done
  const [reason, setReason] = React.useState("");

  // Map backend `plan` enum to plan card id. Backend's "team" is now "max".
  const currentPlanId = user?.plan === "team" ? "max" : user?.plan || "pro";

  return (
    <div className="col gap-5">
      <div className="card">
        <div className="card-head"><h3 className="card-title">Current plan</h3>
          <span className="pill purple"><i className="dot"></i> {currentPlanId}</span></div>
        <div className="card-body">
          <div className="grid-3">
            {PLANS.map((p) => {
              const isCurrent = p.id === currentPlanId;
              return (
                <div key={p.id} className="card flex items-center justify-between" style={{
                  padding: 12,
                  gap: 12,
                  borderColor: isCurrent ? "var(--accent)" : "var(--line)"
                }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="flex items-center" style={{ gap: 8 }}>
                      <div className="mono" style={{ fontSize: 15 }}>{p.name}</div>
                      {isCurrent && <span className="pill ok"><i className="dot"></i> current</span>}
                    </div>
                    <div className="mono" style={{ fontSize: 22, marginTop: 6, lineHeight: 1 }}>
                      {p.price}<span style={{ fontSize: 10, marginLeft: 4, opacity: 0.55 }}>{p.cadence}</span>
                    </div>
                    <div className="mute mono" style={{ fontSize: 11, marginTop: 8 }}>{p.features}</div>
                  </div>
                  {p.cta && !isCurrent &&
                  <button className="btn sm" style={{ whiteSpace: "nowrap" }}>{p.cta}</button>
                  }
                </div>);

            })}
          </div>
        </div>
      </div>

      {/* Subscription management — cancel / pause */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Subscription</h3>
          <span className="mute mono" style={{ fontSize: 11 }}>renews Jun 14 · $25.00</span>
        </div>
        <div className="card-body">
          {cancelStep === "idle" &&
          <div className="flex justify-between items-center" style={{ gap: 16, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono" style={{ fontSize: 13 }}>Pro plan · billed monthly</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
                Cancel anytime. Your plan stays active until the end of the current period, then drops to Free.
              </div>
            </div>
            <div className="flex gap-2">
              <button className="btn ghost">Update payment method</button>
              <button className="btn ghost danger" onClick={() => setCancelStep("confirm")}>Cancel subscription</button>
            </div>
          </div>
          }

          {cancelStep === "confirm" &&
          <div className="col gap-3">
            <div>
              <div className="mono" style={{ fontSize: 13, color: "var(--danger)" }}>Cancel Pro plan?</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
                You'll keep Pro features until <span className="mono" style={{ color: "var(--fg-dim)" }}>Jun 14, 2026</span>.
                After that, your org reverts to Free (public repos only).
              </div>
            </div>
            <div>
              <div className="mute mono" style={{ fontSize: 11, marginBottom: 6 }}>Optional · help us improve</div>
              <select
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              style={{ width: "100%", maxWidth: 360 }}>
                <option value="">Reason for cancelling…</option>
                <option value="cost">Too expensive</option>
                <option value="usage">Not using it enough</option>
                <option value="missing">Missing a feature I need</option>
                <option value="competitor">Switching to another tool</option>
                <option value="bug">Bugs / quality issues</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button className="btn" onClick={() => {setCancelStep("idle");setReason("");}}>Keep my plan</button>
              <button className="btn danger" onClick={() => setCancelStep("done")}>Confirm cancellation</button>
            </div>
          </div>
          }

          {cancelStep === "done" &&
          <div className="col gap-3">
            <div className="flex items-center gap-2">
              <Icon name="check" size={14} color="var(--accent)" />
              <span className="mono" style={{ fontSize: 13 }}>Subscription cancelled</span>
            </div>
            <div className="mute" style={{ fontSize: 12 }}>
              You'll keep Pro features until Jun 14, 2026. Changed your mind?
              <button className="btn sm ghost" style={{ marginLeft: 10 }} onClick={() => setCancelStep("idle")}>
                Reactivate
              </button>
            </div>
          </div>
          }
        </div>
      </div>

      {/* Invoices */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Invoices</h3>
          <span className="mute mono" style={{ fontSize: 11 }}>last 12 months</span>
        </div>
        <div className="card-body">
          {INVOICES.map((inv, i) =>
          <div
          key={inv.id}
          className="flex items-center justify-between"
          style={{
            gap: 12,
            padding: "10px 0",
            borderTop: i === 0 ? "none" : "1px solid var(--line)"
          }}>
            <div className="mono" style={{ fontSize: 13, flex: 1, minWidth: 0 }}>{inv.date}</div>
            <div className="mono" style={{ fontSize: 13, width: 80, textAlign: "right" }}>{inv.amount}</div>
            <span className="pill ok"><i className="dot"></i> {inv.status}</span>
            <button className="btn sm ghost" style={{ whiteSpace: "nowrap" }}>
              <Icon name="eye" size={11} /> View
            </button>
          </div>
          )}
        </div>
      </div>
    </div>);
};


// ─── Account · delete + export ──────────────────────────────────────────
const SetAccount = () => {
  const { user } = useAuth();
  const [step, setStep] = React.useState("idle"); // idle | confirm | done
  const [confirmText, setConfirmText] = React.useState("");
  const REQUIRED = "delete my account";

  const memberSince = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : "—";

  return (
    <div className="col gap-5">
      <div className="card">
        <div className="card-head"><h3 className="card-title">Profile</h3></div>
        <div className="card-body">
          <div className="kv-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
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

      <div className="card">
        <div className="card-head"><h3 className="card-title">Export data</h3></div>
        <div className="card-body">
          <div className="flex justify-between items-center" style={{ gap: 16, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono" style={{ fontSize: 13 }}>Download a copy of your data</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
                Reviews and agent run logs. Delivered as a zipped archive within 24h.
              </div>
            </div>
            <button className="btn ghost">Request export</button>
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
                As the org admin, you must transfer or close <span className="mono" style={{ color: "var(--fg-dim)" }}>acme</span> first.
              </div>
            </div>
            <button className="btn danger" onClick={() => setStep("confirm")}>Delete account…</button>
          </div>
          }

          {step === "confirm" &&
          <div className="col gap-3">
            <div className="mono" style={{ fontSize: 13, color: "var(--danger)" }}>This cannot be undone.</div>
            <div className="mute" style={{ fontSize: 12 }}>
              Type <span className="mono" style={{ color: "var(--fg)" }}>"{REQUIRED}"</span> below to confirm.
            </div>
            <input
            className="input"
            placeholder={REQUIRED}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            style={{ maxWidth: 360, fontFamily: "var(--mono)" }} />
            <div className="flex gap-2">
              <button className="btn" onClick={() => {setStep("idle");setConfirmText("");}}>Cancel</button>
              <button
              className="btn danger"
              disabled={confirmText.trim().toLowerCase() !== REQUIRED}
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


const SetSupport = () =>
<div className="col gap-5">
    <div className="card">
      <div className="card-head"><h3 className="card-title">Support channels</h3></div>
      <div>
        {[
      { name: "Documentation", desc: "Full docs · API reference · self-serve guides", cta: "docs.devasign.dev", i: "doc" },
      { name: "Discord community", desc: "1,840 devs · #help channel, avg reply 12m", cta: "Join Discord", i: "discord" },
      { name: "Email support", desc: "support@devasign.dev · SLA 24h (team), 4h (org)", cta: "Open ticket", i: "send" },
      { name: "Status page", desc: "Uptime · incident history · subscribe", cta: "status.devasign.dev", i: "globe" }].
      map((s) =>
      <div key={s.name} className="row" style={{ display: "grid", gridTemplateColumns: "40px 1fr auto", gap: 14, height: 64 }}>
            <div className="integ-icon"><Icon name={s.i} size={14} /></div>
            <div>
              <div className="mono" style={{ fontSize: 13 }}>{s.name}</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 2 }}>{s.desc}</div>
            </div>
            <button className="btn">{s.cta} <Icon name="external" size={11} /></button>
          </div>
      )}
      </div>
    </div>
  </div>;

export { SettingsPage };
