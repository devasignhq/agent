// @ts-nocheck
// Settings page (and its sub-sections)
import React from "react";
import { Icon } from "./icons";
import { api, installRedirectUrl } from "./api";
import { useAuth } from "./auth-context";
import { IDE_OPTIONS, CLI_OPTIONS, HOW_IT_WORKS } from "./onboarding-data";
import { registerPopup } from "./popup-registry";

// ─── Settings ───────────────────────────────────────────────────────────────
const SET_SECTIONS = [
{ key: "account", name: "Account" },
{ key: "install", name: "Installation" },
{ key: "integrations", name: "Integrations" },
{ key: "usage", name: "Usage" },
{ key: "billing", name: "Plans & billing" },
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
          {sec === "usage" && <SetUsage />}
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
  const [ide, setIde] = React.useState("cursor");
  const [cli, setCli] = React.useState("claude-code");
  const [cliOpen, setCliOpen] = React.useState(true);
  const [howOpen, setHowOpen] = React.useState(false);
  const [installed, setInstalled] = React.useState<Record<string, boolean>>({});

  // Live installs + repos. Refreshes on mount, when an install message arrives
  // from the popup-handshake, and once after the user opens a popup so we
  // catch the round-trip even if the user dismisses the popup themselves.
  const [installs, setInstalls] = React.useState<any[]>([]);
  const [repos, setRepos] = React.useState<any[]>([]);
  const refresh = React.useCallback(() => {
    Promise.all([api.installations(), api.repositories()])
      .then(([is, rs]) => { setInstalls(is); setRepos(rs); })
      .catch(() => {});
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

  const currentIde = IDE_OPTIONS.find((o) => o.key === ide)!;
  const currentCli = CLI_OPTIONS.find((o) => o.key === cli)!;

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

      <div className="card">
        <div className="card-head"><h3 className="card-title">IDE plugin</h3>
          <span className="mono mute" style={{ fontSize: 11 }}>routes you to the IDE's marketplace</span></div>
        <div className="card-body">
          <div className="llm-row" style={{ marginBottom: 12 }}>
            {IDE_OPTIONS.map((o) =>
            <div key={o.key} className={`llm-chip ${ide === o.key ? "picked" : ""}`} onClick={() => setIde(o.key)}>
                <Icon name="code" size={11} /> {o.name}
                {installed[o.key] && <Icon name="check" size={11} color="var(--accent)" />}
              </div>
            )}
          </div>
          <div className="ide-install">
            <div className="ide-install-meta">
              <div className="mono" style={{ fontSize: 13 }}>{currentIde.name}</div>
              <div className="mute mono" style={{ fontSize: 11, marginTop: 2 }}>
                Opens {currentIde.store} · grants <span className="dim">repo:read</span> + <span className="dim">pr:write</span>
              </div>
            </div>
            <button
              className={`btn ${installed[ide] ? "ghost" : "primary"}`}
              onClick={() => setInstalled({ ...installed, [ide]: !installed[ide] })}>

              {installed[ide] ?
              <><Icon name="check" size={12} /> Installed</> :
              <><Icon name="external" size={12} /> Install on {currentIde.name}</>}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3 className="card-title">CLI agent</h3>
          <span className="mono mute" style={{ fontSize: 11 }}>local install · runs review off your machine</span></div>
        <div className="card-body">
          <div className="llm-row" style={{ marginBottom: 12 }}>
            {CLI_OPTIONS.map((o) =>
            <div key={o.key} className={`llm-chip ${cli === o.key ? "picked" : ""}`} onClick={() => setCli(o.key)}>
                <Icon name="terminal" size={11} /> {o.name}
              </div>
            )}
          </div>
          <div className="code-block">
            <code>$ {currentCli.install}</code>
            <button className="btn sm ghost"><Icon name="copy" size={11} /> Copy</button>
          </div>

          <div className="collapse" style={{ marginTop: 14 }}>
            <button className="collapse-head" onClick={() => setCliOpen(!cliOpen)}>
              <Icon name="terminal" size={13} />
              <span className="mono" style={{ fontSize: 12 }}>Core commands · {currentCli.name}</span>
              <span className="flex-1"></span>
              <span className="mute mono" style={{ fontSize: 11 }}>{currentCli.commands.length}</span>
              <span className={`chev ${cliOpen ? "open" : ""}`}><Icon name="chevron-d" size={12} /></span>
            </button>
            {cliOpen &&
            <div className="collapse-body">
                {currentCli.commands.map((cmd) =>
              <div key={cmd.c} className="cmd-row">
                    <code className="cmd-c">$ {cmd.c}</code>
                    <span className="cmd-d">{cmd.d}</span>
                  </div>
              )}
              </div>
            }
          </div>

          <div className="collapse" style={{ marginTop: 10 }}>
            <button className="collapse-head" onClick={() => setHowOpen(!howOpen)}>
              <Icon name="brain" size={13} />
              <span className="mono" style={{ fontSize: 12 }}>How the review agent works</span>
              <span className="flex-1"></span>
              <span className="mute mono" style={{ fontSize: 11 }}>4 steps</span>
              <span className={`chev ${howOpen ? "open" : ""}`}><Icon name="chevron-d" size={12} /></span>
            </button>
            {howOpen &&
            <div className="collapse-body">
                <div className="how-grid">
                  {HOW_IT_WORKS.map((s) =>
                <div key={s.title} className="how-step" style={{ opacity: "1", backgroundColor: "rgba(10, 11, 13, 0)", borderStyle: "none", padding: "12px 14px" }}>
                      <div className="how-icon"><Icon name={s.icon} size={14} /></div>
                      <div className="mono" style={{ fontSize: 12 }}>{s.title}</div>
                      <div className="mute" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.55 }}>{s.body}</div>
                    </div>
                )}
                </div>
              </div>
            }
          </div>
        </div>
      </div>
    </div>);

};

const SetBilling = () => {
  const [cancelStep, setCancelStep] = React.useState("idle"); // idle | confirm | done
  const [reason, setReason] = React.useState("");

  return (
    <div className="col gap-5">
      <div className="card">
        <div className="card-head"><h3 className="card-title">Current plan</h3>
          <span className="pill purple"><i className="dot"></i> team</span></div>
        <div className="card-body">
          <div className="grid-3">
            {[
            { name: "Solo", price: "$0", desc: "1 repo · 50 reviews / mo" },
            { name: "Team", price: "$49", desc: "10 repos · unlimited reviews", current: true },
            { name: "Org", price: "$199", desc: "Unlimited repos · SSO · audit" }].
            map((p) =>
            <div key={p.name} className="card" style={{ padding: 14, borderColor: p.current ? "var(--accent)" : "var(--line)" }}>
                <div className="flex justify-between items-center">
                  <div className="mono">{p.name}</div>
                  {p.current && <span className="pill ok"><i className="dot"></i> current</span>}
                </div>
                <div className="mono" style={{ fontSize: 24, marginTop: 8 }}>{p.price}<span className="mute" style={{ fontSize: 12 }}>/mo</span></div>
                <div className="mute mono" style={{ fontSize: 11, marginTop: 6 }}>{p.desc}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Subscription management — cancel / pause */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Subscription</h3>
          <span className="mute mono" style={{ fontSize: 11 }}>renews Jun 14 · $49.00</span>
        </div>
        <div className="card-body">
          {cancelStep === "idle" &&
          <div className="flex justify-between items-center" style={{ gap: 16, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono" style={{ fontSize: 13 }}>Team plan · billed monthly</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
                Cancel anytime. Your plan stays active until the end of the current period, then drops to Solo.
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
              <div className="mono" style={{ fontSize: 13, color: "var(--danger)" }}>Cancel Team plan?</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
                You'll keep Team features until <span className="mono" style={{ color: "var(--fg-dim)" }}>Jun 14, 2026</span>.
                After that, your org reverts to Solo (1 repo · 50 reviews / mo).
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
              You'll keep Team features until Jun 14, 2026. Changed your mind?
              <button className="btn sm ghost" style={{ marginLeft: 10 }} onClick={() => setCancelStep("idle")}>
                Reactivate
              </button>
            </div>
          </div>
          }
        </div>
      </div>
    </div>);
};


// ─── Usage · activity + agent credits ───────────────────────────────────
const CREDIT_PACKS = [
{ key: "starter", credits: 5000, price: 19, blurb: "≈ 70 reviews on Sonnet 4.5" },
{ key: "growth", credits: 25000, price: 79, blurb: "≈ 360 reviews · best for active teams", popular: true },
{ key: "pro", credits: 100000, price: 249, blurb: "≈ 1.5k reviews · saves 22%" }];

const SetUsage = () => {
  const [balance, setBalance] = React.useState(0);
  const [autoRefill, setAutoRefill] = React.useState(false);
  const [refillAt, setRefillAt] = React.useState(1000);
  const [refillPack, setRefillPack] = React.useState("growth");
  const [pendingPack, setPendingPack] = React.useState(null); // pack key during purchase
  const [bought, setBought] = React.useState(null); // pack key after purchase
  const burnRate = 142; // credits / day mock

  // Pull live subscription once. POST /api/billing/credits adds credits (the
  // backend stub mimics what a Stripe webhook would do post-checkout).
  React.useEffect(() => {
    api.subscription().then((sub) => {
      if (sub) {
        setBalance(sub.credits);
        setAutoRefill(sub.autoRefill);
      }
    }).catch(() => {});
  }, []);

  const buy = async (pack) => {
    setPendingPack(pack.key);
    try {
      await api.addCredits(pack.credits);
      const sub = await api.subscription();
      setBalance(sub?.credits ?? balance + pack.credits);
      setBought(pack.key);
      setTimeout(() => setBought(null), 2400);
    } catch (err) {
      alert(`Top-up failed: ${err.message || err}`);
    } finally {
      setPendingPack(null);
    }
  };

  return (
    <div className="col gap-5">
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Activity · May 2026</h3>
          <span className="mute mono" style={{ fontSize: 11 }}>billing period · resets Jun 14</span>
        </div>
        <div className="card-body">
          {[
          { l: "Reviews", v: "412 / ∞", p: 0.4 },
          { l: "Goal ingests (Loom / image)", v: "188", p: 0.6 }].
          map((u) =>
          <div key={u.l} style={{ marginBottom: 14 }}>
              <div className="flex justify-between" style={{ marginBottom: 6, fontSize: 12 }}>
                <span className="mono mute">{u.l}</span><span className="mono">{u.v}</span>
              </div>
              <div className="progress"><i style={{ width: `${u.p * 100}%` }}></i></div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Credit balance</h3>
          <span className="mute mono" style={{ fontSize: 11 }}>{burnRate}/day burn · ~{Math.floor(balance / burnRate)}d left</span>
        </div>
        <div className="card-body">
          <div className="flex items-baseline gap-3" style={{ flexWrap: "wrap" }}>
            <div className="mono" style={{ fontSize: 36, fontVariantNumeric: "tabular-nums", color: "var(--fg)" }}>
              {balance.toLocaleString()}
            </div>
            <div className="mute mono" style={{ fontSize: 12 }}>credits remaining</div>
          </div>
          <div className="mute" style={{ fontSize: 12, marginTop: 8 }}>
            1 credit ≈ 1k tokens · used by every agent review, goal ingest, and chat. Credits never expire.
          </div>
          <div className="progress" style={{ marginTop: 14 }}>
            <i style={{ width: `${Math.min(100, balance / 250)}%`, background: balance < 1500 ? "var(--warn)" : "var(--accent)" }}></i>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Buy credits</h3>
          <span className="mute mono" style={{ fontSize: 11 }}>charged to card on file · ····4242</span>
        </div>
        <div className="card-body">
          <div className="grid-3">
            {CREDIT_PACKS.map((p) =>
            <div
            key={p.key}
            className="card"
            style={{
              padding: 16,
              borderColor: p.popular ? "var(--accent)" : "var(--line)",
              position: "relative"
            }}>
                {p.popular &&
              <span className="pill ok" style={{ position: "absolute", top: 12, right: 12 }}>
                  <i className="dot"></i> most popular
                </span>
              }
                <div className="mono" style={{ fontSize: 22, fontVariantNumeric: "tabular-nums" }}>
                  {p.credits.toLocaleString()}
                </div>
                <div className="mute mono" style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                  credits
                </div>
                <div className="mono" style={{ fontSize: 15, marginTop: 12 }}>
                  ${p.price}<span className="mute" style={{ fontSize: 11 }}> · one-time</span>
                </div>
                <div className="mute" style={{ fontSize: 12, marginTop: 6, minHeight: 32 }}>{p.blurb}</div>
                <button
                className={`btn ${p.popular ? "primary" : ""}`}
                style={{ width: "100%", marginTop: 14 }}
                disabled={pendingPack === p.key}
                onClick={() => buy(p)}>
                  {pendingPack === p.key ? "Processing…" :
                bought === p.key ? <><Icon name="check" size={11} /> Added</> :
                <>Buy {p.credits.toLocaleString()} credits</>}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3 className="card-title">Auto-refill</h3></div>
        <div className="card-body">
          <div className="flex justify-between items-center" style={{ gap: 16, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono" style={{ fontSize: 13 }}>Top up automatically</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
                When your balance drops below {refillAt.toLocaleString()} credits, we'll buy
                another <span className="mono" style={{ color: "var(--fg-dim)" }}>
                  {CREDIT_PACKS.find((p) => p.key === refillPack)?.credits.toLocaleString()}
                </span> pack and charge your card.
              </div>
            </div>
            <div className={`tog ${autoRefill ? "on" : ""}`} onClick={() => setAutoRefill(!autoRefill)}></div>
          </div>
          {autoRefill &&
          <div className="flex gap-3" style={{ marginTop: 14, flexWrap: "wrap" }}>
            <label className="col gap-1" style={{ flex: 1, minWidth: 140 }}>
              <span className="mute mono" style={{ fontSize: 11 }}>Refill threshold</span>
              <select className="input" value={refillAt} onChange={(e) => setRefillAt(+e.target.value)}>
                <option value={500}>500 credits</option>
                <option value={1000}>1,000 credits</option>
                <option value={2500}>2,500 credits</option>
                <option value={5000}>5,000 credits</option>
              </select>
            </label>
            <label className="col gap-1" style={{ flex: 1, minWidth: 140 }}>
              <span className="mute mono" style={{ fontSize: 11 }}>Refill pack</span>
              <select className="input" value={refillPack} onChange={(e) => setRefillPack(e.target.value)}>
                {CREDIT_PACKS.map((p) =>
                <option key={p.key} value={p.key}>{p.credits.toLocaleString()} · ${p.price}</option>
                )}
              </select>
            </label>
          </div>
          }
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
