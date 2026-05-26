// @ts-nocheck
// Auth + Onboarding screens
import React from "react";
import { Icon } from "./icons";
import { api, installRedirectUrl } from "./api";
import { registerPopup } from "./popup-registry";
import { IDE_OPTIONS, CLI_OPTIONS, HOW_IT_WORKS } from "./onboarding-data";

const Auth = ({ onSignIn }) => (
  <div className="auth-shell">
    <div className="auth-left">
      <div className="auth-logo">
        <img src={(typeof window !== "undefined" && window.__resources && window.__resources.logo) || "devasign-logo.svg"} alt="DevAsign" className="auth-logo-img" />
      </div>
      <div className="auth-card">
        <div className="ob-eyebrow">code review · multimodal</div>
        <h1 className="auth-h1">Ship code that <span className="accent">matches the goal.</span></h1>
        <p className="auth-p">
          DevAsign ingests the ticket, Loom or screenshot first — then reviews PRs against
          that goal, right inside your IDE or CLI.
        </p>
        <button className="gh-btn" onClick={onSignIn}>
          <Icon name="github" size={18} />
          Continue with GitHub
        </button>
        <p className="mute mono" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.6 }}>
          By continuing you agree to the Terms and Privacy.<br/>
          We only request <span className="dim">repo:read</span> and <span className="dim">pull_request:write</span> scopes.
        </p>
      </div>
      <div className="auth-foot">
        <span>v0.7.2-alpha</span>
        <span>status: <span className="txt-accent">all systems operational</span></span>
      </div>
    </div>
    <div className="auth-right">
      <div className="terminal" style={{ height: "100%", background: "transparent" }}>
        <div className="terminal-head" style={{ background: "var(--bg-2)" }}>
          <div className="tt-dots">
            <i className="dot" style={{ background: "#ff5a5f" }}></i>
            <i className="dot" style={{ background: "#f5a524" }}></i>
            <i className="dot" style={{ background: "#ff7a3d" }}></i>
          </div>
          <span className="tt-name">devasign — review · PR #482</span>
        </div>
        <div className="terminal-body">
          <div className="t-line t-comment"># devasign review queued</div>
          <div className="t-line"><span className="t-prompt">›</span> <span className="t-cmd">ingest goal</span> <span className="t-dim">--source linear://ENG-1284</span></div>
          <div className="t-line t-dim">  ✓ pulled ticket   "Add USDC withdraw flow w/ multi-chain"</div>
          <div className="t-line t-dim">  ✓ parsed loom    36s · "user clicks Withdraw, picks chain, confirms"</div>
          <div className="t-line t-dim">  ✓ ocr screenshot 1280×800 · figma frame 4 · CTA copy locked</div>
          <div className="t-line">&nbsp;</div>
          <div className="t-line"><span className="t-prompt">›</span> <span className="t-cmd">review</span> <span className="t-dim">--pr 482 --model sonnet-4.5</span></div>
          <div className="t-line t-dim">  → analyzing diff (+247 / −38) across 9 files</div>
          <div className="t-line t-dim">  → cross-checking against goal frame…</div>
          <div className="t-line">&nbsp;</div>
          <div className="t-box">
            <div className="t-line"><span className="t-ok">▸ acceptance</span> <span className="t-dim">7 / 9 met</span></div>
            <div className="t-line t-dim">  · multi-chain selector ✓</div>
            <div className="t-line t-dim">  · txn confirm modal   ✓</div>
            <div className="t-line t-dim">  · loading state       <span className="t-warn">⚠ missing on Tron path</span></div>
          </div>
          <div className="t-box danger">
            <div className="t-line"><span className="t-danger">▸ blockers</span> <span className="t-dim">2</span></div>
            <div className="t-line t-dim">  · WithdrawForm.tsx:142 — chain id not validated</div>
            <div className="t-line t-dim">  · useUSDC.ts:88     — wallet check fires after submit</div>
          </div>
          <div className="t-line">&nbsp;</div>
          <div className="t-line t-comment"># posting inline comments to PR…</div>
          <div className="t-line"><span className="t-ok">  ✓ 4 comments posted</span> <span className="t-dim">github.com/acme/pay/pull/482</span></div>
          <div className="t-line"><span className="t-prompt">›</span> <span className="t-cmd">_</span><span className="cursor"></span></div>
        </div>
      </div>
    </div>
  </div>
);
export { Auth };


// ─── Onboarding ──────────────────────────────────────────────────────────────

const OB_STEPS = [
  { key: "github",  title: "Install GitHub App",  sub: "1 of 3 · required" },
  { key: "integ",   title: "Connect integrations", sub: "2 of 3 · optional" },
  { key: "devtool", title: "Setup IDE & CLI",      sub: "3 of 3 · pick at least one" },
];

const Onboarding = ({ onDone }) => {
  const [step, setStep] = React.useState(0);
  // GitHub App installation state — populated from /api/installations and
  // /api/repositories the moment the user returns from github.com.
  const [ghInstall, setGhInstall] = React.useState({
    status: "idle", // idle | connecting | installed
    accounts: [],   // [{ login, kind, avatar, repos: [{ name, lang, prs, branch, visibility }] }]
  });

  // Load installations on mount and whenever onboarding becomes visible.
  // Newly-created installs land here via /api/installations/:id/link in app.tsx.
  const refreshInstalls = React.useCallback(async () => {
    try {
      const [installs, repos] = await Promise.all([api.installations(), api.repositories()]);
      if (installs.length === 0) {
        // Don't clobber "connecting" — that means the popup is still working
        // through the install/link. Only fall to "idle" when we *know* there
        // are no installs and we're not mid-flow (e.g. initial mount).
        setGhInstall((s) => (s.status === "connecting" ? s : { status: "idle", accounts: [] }));
        return;
      }
      const byInstall = new Map();
      for (const inst of installs) byInstall.set(inst.id, { inst, repos: [] });
      for (const r of repos) {
        const entry = byInstall.get(r.installationId);
        if (entry) entry.repos.push(r);
      }
      const accounts = [...byInstall.values()].map(({ inst, repos }) => ({
        login: inst.accountLogin,
        kind: inst.accountLogin === inst.accountLogin.toLowerCase() ? "org" : "personal",
        avatar: inst.accountLogin.charAt(0).toUpperCase(),
        repos: repos.map((r) => ({
          name: `${r.owner}/${r.name}`,
          lang: "—",
          prs: 0,
          branch: r.defaultBranch,
          visibility: "private",
        })),
      }));
      setGhInstall({ status: "installed", accounts });
    } catch (err) {
      console.warn("[onboarding] refresh installs failed", err);
    }
  }, []);
  // On mount: snapshot the initial install state so we can distinguish
  // "user already had an install" (don't auto-advance) from "install just
  // happened" (do auto-advance).
  const initialInstallRef = React.useRef<null | boolean>(null);
  React.useEffect(() => {
    refreshInstalls().then(() => {
      if (initialInstallRef.current === null) {
        // populated by the setState in refreshInstalls — read it back next tick
        initialInstallRef.current = false; // overwritten below if installed
      }
    });
  }, [refreshInstalls]);
  // Track the initial install state once it's known.
  React.useEffect(() => {
    if (initialInstallRef.current === null && ghInstall.status !== "idle") {
      initialInstallRef.current = ghInstall.status === "installed";
    }
  }, [ghInstall.status]);

  // Poll briefly after the user is sent to GitHub so install webhooks have a
  // chance to land while the user is choosing repos. ALSO when the popup
  // message arrives, the linkInstallation round-trip on the App side might
  // still be in flight — polling catches the install regardless.
  React.useEffect(() => {
    if (ghInstall.status !== "connecting") return;
    const id = setInterval(refreshInstalls, 2500);
    return () => clearInterval(id);
  }, [ghInstall.status, refreshInstalls]);

  // Refresh whenever an install-done message arrives from the popup-
  // handshake. We don't trust the App-level link to race us — link directly
  // here too (the backend handler is idempotent: re-linking the same install
  // to the same user is a no-op). Then refresh; if the link's GitHub round-
  // trips are slow, fall back to a tighter poll for the next several seconds.
  const installPollRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d: any = e.data;
      if (!d || d.type !== "devasign_install_done") return;
      const installationId = Number(d.installationId);
      api.linkInstallation(installationId)
        .catch((err) => console.warn("[onboarding] link failed", err))
        .finally(() => { refreshInstalls(); });
      // Insurance: 600ms poll for up to ~8s. A separate effect below clears
      // it the moment we see "installed".
      if (installPollRef.current !== null) window.clearInterval(installPollRef.current);
      let attempts = 0;
      installPollRef.current = window.setInterval(() => {
        attempts++;
        refreshInstalls();
        if (attempts >= 13 && installPollRef.current !== null) {
          window.clearInterval(installPollRef.current);
          installPollRef.current = null;
        }
      }, 600);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [refreshInstalls]);
  // Stop the insurance poll once the install is visible to us.
  React.useEffect(() => {
    if (ghInstall.status === "installed" && installPollRef.current !== null) {
      window.clearInterval(installPollRef.current);
      installPollRef.current = null;
    }
  }, [ghInstall.status]);

  const [integ, setInteg] = React.useState({ slack: false, linear: false, discord: false });
  const [ide, setIde] = React.useState("cursor");
  const [cli, setCli] = React.useState("claude-code");

  const ghReady = ghInstall.status === "installed";
  const canAdvance = step !== 0 || ghReady;

  // Auto-advance step 0 → 1 the moment an install lands, but only if the user
  // didn't already have one when they arrived (otherwise we'd jerk them past
  // step 0 every time they revisit it via the Back button).
  const advancedRef = React.useRef(false);
  React.useEffect(() => {
    if (advancedRef.current) return;
    if (step !== 0) return;
    if (ghInstall.status !== "installed") return;
    if (initialInstallRef.current === true) return; // they already had one
    advancedRef.current = true;
    // Tiny delay so the user sees the "installed" state flip before the step
    // transition — feels less abrupt than instant.
    const id = setTimeout(() => setStep(1), 600);
    return () => clearTimeout(id);
  }, [ghInstall.status, step]);

  const next = () => {
    if (!canAdvance) return;
    step < 2 ? setStep(step + 1) : onDone();
  };
  const back = () => step > 0 && setStep(step - 1);

  return (
    <div className="ob-shell">
      <div className="ob-side">
        <div className="auth-logo" style={{ marginBottom: 32 }}>
          <img src={(typeof window !== "undefined" && window.__resources && window.__resources.logo) || "devasign-logo.svg"} alt="DevAsign" className="auth-logo-img" />
        </div>
        {OB_STEPS.map((s, i) => (
          <div key={s.key} className={`ob-step ${i < step ? "done" : ""} ${i === step ? "current" : ""}`}>
            <div className="ob-bullet">{i < step ? <Icon name="check" size={12}/> : i + 1}</div>
            <div>
              <div className="ob-step-title">{s.title}</div>
              <div className="ob-step-sub">{s.sub}</div>
            </div>
          </div>
        ))}
        <div style={{ marginTop: "auto", paddingTop: 32, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-faint)", lineHeight: 1.6 }}>
          press <span className="kbd-hint">⌘</span> + <span className="kbd-hint">↵</span> to continue
        </div>
      </div>

      <div className="ob-main">
        {step === 0 && <OBGitHub install={ghInstall} setInstall={setGhInstall} refreshInstalls={refreshInstalls} />}
        {step === 1 && <OBInteg integ={integ} setInteg={setInteg} />}
        {step === 2 && <OBDevtool ide={ide} setIde={setIde} cli={cli} setCli={setCli} />}

        <div className="ob-foot">
          <button className="btn ghost" onClick={back} disabled={step === 0} style={step === 0 ? { opacity: 0.4 } : {}}>
            ← Back
          </button>
          <div className="flex gap-3 items-center">
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-mute)" }}>
              step {step + 1} / 3
            </span>
            {step === 0 && !ghReady && (
              <span className="mono" style={{ fontSize: 11, color: "var(--warn)" }}>
                · install the GitHub App to continue
              </span>
            )}
            {step !== 0 && (
              <button className="btn ghost" onClick={next}>Skip</button>
            )}
            <button
              className="btn primary"
              onClick={next}
              disabled={!canAdvance}
              style={!canAdvance ? { opacity: 0.4, cursor: "not-allowed" } : {}}
            >
              {step === 2 ? "Finish setup" : "Continue"} <Icon name="chevron-r" size={14}/>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
export { Onboarding };


// Simulates what the GitHub App's installation webhook would deliver back to
// DevAsign after the user picks repos on github.com. The list of repositories
// here is read-only in our UI — granting/revoking happens on GitHub.
const GH_INSTALL_RESULT = {
  accounts: [
    {
      login: "maya-dev",
      kind: "personal",
      avatar: "M",
      repos: [
        { name: "maya-dev/dotfiles",    lang: "Shell",      prs: 12,   branch: "main", visibility: "private" },
        { name: "maya-dev/sketchpad",   lang: "TypeScript", prs: 38,   branch: "main", visibility: "public"  },
      ],
    },
    {
      login: "acme",
      kind: "org",
      avatar: "A",
      repos: [
        { name: "acme/pay",     lang: "TypeScript", prs: 1284, branch: "main", visibility: "private" },
        { name: "acme/admin",   lang: "TypeScript", prs: 612,  branch: "main", visibility: "private" },
        { name: "acme/mobile",  lang: "Swift",      prs: 88,   branch: "main", visibility: "private" },
        { name: "acme/infra",   lang: "Go",         prs: 410,  branch: "main", visibility: "private" },
      ],
    },
  ],
};

const OBGitHub = ({ install, setInstall, refreshInstalls }) => {
  const { status, accounts } = install;

  const launchGitHub = () => {
    if (status === "connecting") return;
    setInstall((s) => ({ ...s, status: "connecting" }));
    // Popup the install flow so the user stays on the onboarding page. The
    // popup lands on github.com/apps/<app>/installations/new (via the backend
    // redirect), and on return main.tsx detects the popup, posts a message to
    // us, and self-closes. The opener-side message listener (in app.tsx)
    // claims the install via /api/installations/:id/link.
    const popup = window.open(
      installRedirectUrl,
      "devasign_install",
      "width=920,height=780,menubar=no,toolbar=no,location=yes"
    );
    if (!popup) {
      // Popup blocked → top-level navigation fallback.
      window.location.href = installRedirectUrl;
      return;
    }
    // Register so the opener-side message listener can call popup.close()
    // once GitHub redirects us back (self-close is blocked by browsers after
    // the popup's cross-origin navigation history).
    registerPopup("install", popup);
    popup.focus();
    // When the popup closes, give the link round-trip a moment to finish:
    // wait for refreshInstalls to resolve before deciding whether to reset.
    // If by then status is "installed" (refresh found the new install), keep
    // it; if still "connecting", the user closed without finishing — go idle.
    const watch = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(watch);
      Promise.resolve(refreshInstalls?.())
        .catch(() => {})
        .finally(() => {
          setInstall((s) => (s.status === "connecting" ? { status: "idle", accounts: [] } : s));
        });
    }, 500);
  };

  const totalRepos = accounts.reduce((n, a) => n + a.repos.length, 0);

  return (
    <>
      <div className="ob-eyebrow">step 01 / github</div>
      <h1 className="ob-title">Install the DevAsign GitHub App.</h1>
      <p className="ob-desc">
        DevAsign reads PR diffs and posts inline review comments through a GitHub App you
        install on your personal account or organization. Pick which repositories the app
        can see on GitHub — that's the source of truth.
      </p>

      {status !== "installed" ? (
        <GHInstallPanel status={status} onLaunch={launchGitHub} />
      ) : (
        <GHRepoBrowser
          accounts={accounts}
          onReconfigure={launchGitHub}
          totalRepos={totalRepos}
        />
      )}
    </>
  );
};

const GHInstallPanel = ({ status, onLaunch }) => {
  const connecting = status === "connecting";
  return (
    <div className="gh-install">
      <div className="gh-install-hero">
        <div className="gh-install-icon">
          <Icon name="github" size={28}/>
        </div>
        <div className="flex-1">
          <div className="gh-install-title">DevAsign for GitHub</div>
          <div className="gh-install-sub mono">
            github.com/apps/devasign · installs into your account or org
          </div>
        </div>
        <span className={`pill ${connecting ? "info" : "warn"}`}>
          <i className={`dot ${connecting ? "pulse" : ""}`}></i>
          {connecting ? "waiting for github" : "not installed"}
        </span>
      </div>

      <ul className="gh-install-list">
        <li>
          <Icon name="check" size={11} color="var(--accent)"/>
          <span><b>You</b> choose which repos the app can access on GitHub — DevAsign only ever sees what you grant.</span>
        </li>
        <li>
          <Icon name="check" size={11} color="var(--accent)"/>
          <span>Scopes requested: <span className="dim mono">contents:read</span>, <span className="dim mono">pull_requests:write</span>, <span className="dim mono">metadata:read</span>.</span>
        </li>
        <li>
          <Icon name="check" size={11} color="var(--accent)"/>
          <span>You can add, remove, or change repos any time from GitHub settings — changes sync back here instantly.</span>
        </li>
      </ul>

      <div className="gh-install-actions">
        <button
          className="btn primary gh-install-cta"
          onClick={onLaunch}
          disabled={connecting}
        >
          {connecting ? (
            <>
              <span className="dot pulse" style={{ width: 7, height: 7, background: "currentColor" }}></span>
              Waiting for GitHub…
            </>
          ) : (
            <>
              <Icon name="github" size={14}/>
              Configure on GitHub
              <Icon name="external" size={11}/>
            </>
          )}
        </button>
      </div>
    </div>
  );
};

const GHRepoBrowser = ({ accounts, onReconfigure, totalRepos }) => (
  <>
    <div className="gh-installed-banner">
      <div className="gh-installed-icon">
        <Icon name="check" size={12}/>
      </div>
      <div className="flex-1">
        <div className="mono" style={{ fontSize: 12, color: "var(--fg)" }}>
          GitHub App installed
        </div>
        <div className="mute mono" style={{ fontSize: 11, marginTop: 1 }}>
          {totalRepos} repositories · {accounts.length} account{accounts.length === 1 ? "" : "s"}
        </div>
      </div>
      <button className="btn sm ghost" onClick={onReconfigure}>
        <Icon name="external" size={11}/> Edit on GitHub
      </button>
    </div>

    <div className="flex justify-between items-center" style={{ marginBottom: 8, marginTop: 18 }}>
      <span className="label" style={{ marginBottom: 0 }}>connected repositories</span>
      <span className="mono" style={{ fontSize: 11, color: "var(--fg-faint)" }}>
        read-only · change on github
      </span>
    </div>

    <div className="gh-accounts">
      {accounts.map((acct) => (
        <div key={acct.login} className="gh-account">
          <div className="gh-account-head">
            <div className={`gh-account-avatar ${acct.kind}`}>{acct.avatar}</div>
            <span className="mono gh-account-name">{acct.login}</span>
            <span className="gh-account-kind mono">
              {acct.kind === "org" ? "organization" : "personal"}
            </span>
            <span className="flex-1"></span>
            <span className="mono gh-account-count">{acct.repos.length} repo{acct.repos.length === 1 ? "" : "s"}</span>
          </div>

          <ul className="gh-repo-list">
            {acct.repos.map((r) => (
              <li key={r.name} className="gh-repo-row">
                <Icon name="git" size={11} color="var(--fg-faint)"/>
                <span className="mono gh-repo-name">{r.name}</span>
                <span className="gh-repo-meta mono">
                  {r.lang} · {r.prs.toLocaleString()} PRs
                </span>
                <span className="flex-1"></span>
                <span className={`gh-repo-vis mono ${r.visibility}`}>{r.visibility}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  </>
);

const OBInteg = ({ integ, setInteg }) => {
  const items = [
    { key: "slack",   icon: "slack",   name: "Slack",   desc: "Get review summaries in a channel. Mention @devasign to re-review." },
    { key: "linear",  icon: "linear",  name: "Linear",  desc: "Auto-pull goal context from the linked ticket on PR open." },
    { key: "discord", icon: "discord", name: "Discord", desc: "Notify on bounty applications and PR submissions." },
  ];

  const [busy, setBusy] = React.useState(null);  // key currently being connected/disconnected
  const [rows, setRows] = React.useState([]);    // /api/integrations response
  React.useEffect(() => {
    api.integrations().then((list) => {
      setRows(list);
      const next = { slack: false, linear: false, discord: false };
      for (const r of list) next[r.type] = true;
      setInteg(next);
    }).catch(() => {});
  }, []);

  const toggle = async (key) => {
    if (busy) return;
    setBusy(key);
    try {
      if (integ[key]) {
        const row = rows.find((r) => r.type === key);
        if (row) {
          await api.removeIntegration(row.id);
          setRows((rs) => rs.filter((r) => r.id !== row.id));
        }
        setInteg({ ...integ, [key]: false });
      } else {
        // For onboarding we store a placeholder token; Settings has the full
        // OAuth/token-paste flow. The real integration UX lives in §6 of the
        // spec — this is the simplest credible wire-up so the agent has *some*
        // tokens to broadcast with.
        const token = prompt(
          key === "slack"   ? "Slack bot token (xoxb-…)" :
          key === "linear"  ? "Linear API key (lin_api_…)" :
                              "Discord bot token"
        );
        if (!token) { setBusy(null); return; }
        const channel =
          key === "slack" ? (prompt("Channel to broadcast verdicts to (e.g. #pr-reviews)") || "")
          : key === "discord" ? (prompt("Discord channel ID") || "")
          : "";
        const created = await api.addIntegration({
          type: key,
          tokens: key === "linear" ? { apiKey: token } : { botToken: token },
          workspaceMeta: channel
            ? (key === "slack" ? { channel } : { channelId: channel })
            : {},
        });
        setRows((rs) => [...rs, { id: created.id, type: key, workspaceMeta: {}, createdAt: Date.now() }]);
        setInteg({ ...integ, [key]: true });
      }
    } catch (err) {
      alert(`Integration ${integ[key] ? "disconnect" : "connect"} failed: ${err.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="ob-eyebrow">step 02 / integrations</div>
      <h1 className="ob-title">Wire DevAsign into where you already work.</h1>
      <p className="ob-desc">
        Optional. Connect Slack, Linear or Discord so the agent can pull ticket context
        and broadcast review verdicts to your team.
      </p>

      <div className="integ-list">
        {items.map(it => (
          <div key={it.key} className={`integ ${integ[it.key] ? "connected" : ""}`}>
            <div className="integ-icon"><Icon name={it.icon} size={16}/></div>
            <div>
              <div className="integ-name">{it.name}</div>
              <div className="integ-desc">{it.desc}</div>
            </div>
            <span className={`pill ${integ[it.key] ? "ok" : ""}`}>
              {integ[it.key] ? <><i className="dot"></i> connected</> : "not connected"}
            </span>
            <button
              className={`btn ${integ[it.key] ? "ghost" : ""}`}
              onClick={() => toggle(it.key)}
              disabled={busy === it.key}
            >
              {busy === it.key ? "…" : integ[it.key] ? "Disconnect" : "Connect"}
            </button>
          </div>
        ))}
      </div>
    </>
  );
};

const OBDevtool = ({ ide, setIde, cli, setCli }) => {
  const [howOpen, setHowOpen] = React.useState(false);
  const [cliOpen, setCliOpen] = React.useState(true);
  const [installed, setInstalled] = React.useState({});
  const currentIde = IDE_OPTIONS.find(o => o.key === ide);
  const currentCli = CLI_OPTIONS.find(o => o.key === cli);

  return (
    <>
      <div className="ob-eyebrow">step 03 / devtools</div>
      <h1 className="ob-title">Where should DevAsign live?</h1>
      <p className="ob-desc">
        Install the review agent in your IDE so it can drop inline comments on the diff
        view, and / or in your CLI vibe-coding workflow.
      </p>

      <label className="label">IDE plugin</label>
      <div className="llm-row" style={{ marginBottom: 12 }}>
        {IDE_OPTIONS.map(o => (
          <div key={o.key} className={`llm-chip ${ide === o.key ? "picked" : ""}`} onClick={() => setIde(o.key)}>
            <Icon name="code" size={11}/> {o.name}
            {installed[o.key] && <Icon name="check" size={11} color="var(--accent)"/>}
          </div>
        ))}
      </div>

      <div className="ide-install" style={{ marginBottom: 24 }}>
        <div className="ide-install-meta">
          <div className="mono" style={{ fontSize: 13 }}>{currentIde.name}</div>
          <div className="mute mono" style={{ fontSize: 11, marginTop: 2 }}>
            Opens {currentIde.store} · grants <span className="dim">repo:read</span> + <span className="dim">pr:write</span>
          </div>
        </div>
        <button
          className={`btn ${installed[ide] ? "ghost" : "primary"}`}
          onClick={() => setInstalled({ ...installed, [ide]: !installed[ide] })}
        >
          {installed[ide]
            ? <><Icon name="check" size={12}/> Installed</>
            : <><Icon name="external" size={12}/> Install on {currentIde.name}</>}
        </button>
      </div>

      <label className="label">CLI agent</label>
      <div className="llm-row" style={{ marginBottom: 12 }}>
        {CLI_OPTIONS.map(o => (
          <div key={o.key} className={`llm-chip ${cli === o.key ? "picked" : ""}`} onClick={() => setCli(o.key)}>
            <Icon name="terminal" size={11}/> {o.name}
          </div>
        ))}
      </div>
      <div className="code-block">
        <code>$ {currentCli.install}</code>
        <button className="btn sm ghost"><Icon name="copy" size={11}/> Copy</button>
      </div>

      {/* Collapsible: CLI commands for selected agent */}
      <div className="collapse" style={{ marginTop: 14 }}>
        <button className="collapse-head" onClick={() => setCliOpen(!cliOpen)}>
          <Icon name="terminal" size={13}/>
          <span className="mono" style={{ fontSize: 12 }}>Core commands · {currentCli.name}</span>
          <span className="flex-1"></span>
          <span className="mute mono" style={{ fontSize: 11 }}>{currentCli.commands.length}</span>
          <span className={`chev ${cliOpen ? "open" : ""}`}><Icon name="chevron-d" size={12}/></span>
        </button>
        {cliOpen && (
          <div className="collapse-body">
            {currentCli.commands.map(cmd => (
              <div key={cmd.c} className="cmd-row">
                <code className="cmd-c">$ {cmd.c}</code>
                <span className="cmd-d">{cmd.d}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Collapsible: How the review agent works */}
      <div className="collapse" style={{ marginTop: 10 }}>
        <button className="collapse-head" onClick={() => setHowOpen(!howOpen)}>
          <Icon name="brain" size={13}/>
          <span className="mono" style={{ fontSize: 12 }}>How the review agent works</span>
          <span className="flex-1"></span>
          <span className="mute mono" style={{ fontSize: 11 }}>4 steps</span>
          <span className={`chev ${howOpen ? "open" : ""}`}><Icon name="chevron-d" size={12}/></span>
        </button>
        {howOpen && (
          <div className="collapse-body">
            <div className="how-grid">
              {HOW_IT_WORKS.map(s => (
                <div key={s.title} className="how-step">
                  <div className="how-icon"><Icon name={s.icon} size={14}/></div>
                  <div className="mono" style={{ fontSize: 12 }}>{s.title}</div>
                  <div className="mute" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.55 }}>{s.body}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16, padding: 14, display: "flex", gap: 12, alignItems: "center" }}>
        <Icon name="shield" size={16} color="var(--accent)"/>
        <div className="mute" style={{ fontSize: 12 }}>
          Plugins run review locally and never upload your source. Only diffs + goal context are sent to your chosen LLM.
        </div>
      </div>
    </>
  );
};

const ChainLogo = ({ chain, size = 18 }) => {
  const s = size;
  switch (chain) {
    case "stellar":
      // Schematic rocket — angled body + fins
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="11" fill="#fff" stroke="rgba(0,0,0,0.08)"/>
          <path d="M4 8.5l16-4M4 15.5l16 4M5.5 12h13" stroke="#000" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
      );
    case "solana":
      // Three slanted parallel bars
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="11" fill="#fff" stroke="rgba(0,0,0,0.08)"/>
          <defs>
            <linearGradient id="solg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#9945ff"/>
              <stop offset="1" stopColor="#14f195"/>
            </linearGradient>
          </defs>
          <path d="M7.5 7.5h8.5l-1.5 2H6zM6 11h10l-1.5 2H4.5zM4.5 14.5h10l-1.5 2H3z" fill="url(#solg)"/>
        </svg>
      );
    case "base":
      // Solid blue circle with white square cutout
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="11" fill="#0052ff"/>
          <path d="M12 5.5a6.5 6.5 0 100 13H6v-13z" fill="#fff"/>
        </svg>
      );
    case "polygon":
      // Two overlapping hexagons (simplified)
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="11" fill="#fff" stroke="rgba(0,0,0,0.08)"/>
          <path d="M9 7l3-1.7L15 7v3.4L12 12 9 10.4zM9 13.6L12 12l3 1.6V17l-3 1.7-3-1.7z" fill="#8247e5"/>
        </svg>
      );
    case "tron":
      // Triangular mark with internal line
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="11" fill="#fff" stroke="rgba(0,0,0,0.08)"/>
          <path d="M5 7l14 1.5-9 11z" fill="#ff060a"/>
          <path d="M5 7l5 12.5M19 8.5l-9 11" stroke="#fff" strokeWidth="0.6"/>
        </svg>
      );
    case "arbitrum":
      // Stylized A
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="11" fill="#213147"/>
          <path d="M11.2 7.5l-4.4 9.5h2l1-2.4h4.4l1 2.4h2.1l-4.4-9.5zm1.6 5.4h-3l1.5-3.6z" fill="#12aaff"/>
          <path d="M14 7.5l3.2 6.7-.7 1.7-3.5-7.5z" fill="#9dcced"/>
        </svg>
      );
    default: return null;
  }
};
export { ChainLogo };
