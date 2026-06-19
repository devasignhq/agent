// @ts-nocheck
// Auth + Onboarding screens
import React from "react";
import { Icon } from "./icons";
import { api, installRedirectUrl, linearConnectUrl } from "./api";
import { registerPopup, closePopup } from "./popup-registry";
import { useAuth } from "./auth-context";
import { PLANS } from "./screens-rest";

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
          DevAsign ingests the ticket, Loom or screenshot first — then reviews every PR
          against that goal.
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

// Onboarding stages. Pricing comes first; integrations only exist for paid plans
// (free users skip straight to the app after configuring repositories). The
// visible list is built per-plan in Onboarding, so the "N of M" labels and the
// step rail stay correct whether the user has 2 (free) or 3 (paid) steps.
const STEP_DEFS = {
  pricing:      { title: "Choose your plan",       note: "required" },
  repository:   { title: "Configure repositories", note: "required" },
  integrations: { title: "Connect Workspace",      note: "optional" },
};

const Onboarding = ({ onDone }) => {
  const { user } = useAuth();
  const plan = user?.plan || "free";
  const isPaid = plan !== "free";
  // Visible steps depend on plan: free skips the (Pro/Max-only) integrations step.
  const stepKeys = isPaid ? ["pricing", "repository", "integrations"] : ["pricing", "repository"];

  const [step, setStep] = React.useState(0);
  const stepKey = stepKeys[Math.min(step, stepKeys.length - 1)];
  // GitHub App installation state — populated from /api/installations and
  // /api/repositories the moment the user returns from github.com.
  const [ghInstall, setGhInstall] = React.useState({
    status: "idle", // idle | connecting | installed
    accounts: [],   // [{ login, kind, shared, avatar, repos: [{ name, lang, prs, branch, visibility }] }]
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
        kind: inst.accountType === "Organization" ? "org" : "personal",
        // `shared` (set by GET /api/installations) means another org owner
        // installed the App — surfaced as a banner so the user isn't confused to
        // find it already installed on their org.
        shared: !!inst.shared,
        avatar: inst.accountLogin.charAt(0).toUpperCase(),
        repos: repos.map((r) => ({
          name: `${r.owner}/${r.name}`,
          lang: "—",
          prs: 0,
          branch: r.defaultBranch,
          visibility: r.private ? "private" : "public",
        })),
      }));
      setGhInstall({ status: "installed", accounts });
    } catch (err) {
      console.warn("[onboarding] refresh installs failed", err);
    }
  }, []);
  // Load installations on mount (and after the user returns from GitHub).
  React.useEffect(() => { refreshInstalls(); }, [refreshInstalls]);

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

  const [integ, setInteg] = React.useState({ linear: false });

  const ghReady = ghInstall.status === "installed";
  // Pricing advances via its own plan CTAs; repository needs an install; the
  // optional integrations step can always advance.
  const canAdvance = stepKey === "pricing" ? false : stepKey === "repository" ? ghReady : true;

  // Auto-advance pricing → repository once a paid plan is detected. Covers the
  // return from Stripe Checkout (auth reloaded → plan is now pro/max) and a cold
  // return after subscribing — a paid user should never be shown pricing again.
  const billingAdvancedRef = React.useRef(false);
  React.useEffect(() => {
    if (billingAdvancedRef.current) return;
    if (stepKey !== "pricing" || !isPaid) return;
    billingAdvancedRef.current = true;
    setStep(1);
  }, [isPaid, stepKey]);

  const next = () => {
    if (!canAdvance) return;
    step < stepKeys.length - 1 ? setStep(step + 1) : onDone();
  };
  const back = () => step > 0 && setStep(step - 1);

  return (
    <div className="ob-shell">
      <div className="ob-side">
        <div className="auth-logo" style={{ marginBottom: 32 }}>
          <img src={(typeof window !== "undefined" && window.__resources && window.__resources.logo) || "devasign-logo.svg"} alt="DevAsign" className="auth-logo-img" />
        </div>
        {stepKeys.map((key, i) => (
          <div key={key} className={`ob-step ${i < step ? "done" : ""} ${i === step ? "current" : ""}`}>
            <div className="ob-bullet">{i < step ? <Icon name="check" size={12}/> : i + 1}</div>
            <div>
              <div className="ob-step-title">{STEP_DEFS[key].title}</div>
              <div className="ob-step-sub">{i + 1} of {stepKeys.length} · {STEP_DEFS[key].note}</div>
            </div>
          </div>
        ))}
        <div style={{ marginTop: "auto", paddingTop: 32, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-faint)", lineHeight: 1.6 }}>
          press <span className="kbd-hint">⌘</span> + <span className="kbd-hint">↵</span> to continue
        </div>
      </div>

      <div className="ob-main">
        {stepKey === "pricing" && <OBPricing onChooseFree={() => setStep(1)} />}
        {stepKey === "repository" && <OBGitHub install={ghInstall} setInstall={setGhInstall} refreshInstalls={refreshInstalls} isPaid={isPaid} />}
        {stepKey === "integrations" && <OBInteg integ={integ} setInteg={setInteg} />}

        <div className="ob-foot">
          <button className="btn ghost" onClick={back} disabled={step === 0} style={step === 0 ? { opacity: 0.4 } : {}}>
            ← Back
          </button>
          <div className="flex gap-3 items-center">
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-mute)" }}>
              step {step + 1} / {stepKeys.length}
            </span>
            {stepKey === "repository" && !ghReady && (
              <span className="mono" style={{ fontSize: 11, color: "var(--warn)" }}>
                · install the GitHub App to continue
              </span>
            )}
            {stepKey === "integrations" && (
              <button className="btn ghost" onClick={next}>Skip</button>
            )}
            {/* Pricing has no Continue — the plan cards drive that choice. */}
            {stepKey !== "pricing" && (
              <button
                className="btn primary"
                onClick={next}
                disabled={!canAdvance}
                style={!canAdvance ? { opacity: 0.4, cursor: "not-allowed" } : {}}
              >
                {step === stepKeys.length - 1 ? "Finish setup" : "Continue"} <Icon name="chevron-r" size={14}/>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
export { Onboarding };

// Step 0 — plan selection. Reuses the PLANS data + plan-card styles from
// Settings → Billing. Free advances in-app (no backend call, the user is already
// on Free); Pro/Max launch Stripe Checkout with the 14-day trial and the
// onboarding return marker (?ob=billing → resume at the repository step).
const OBPricing = ({ onChooseFree }) => {
  const [billInterval, setBillInterval] = React.useState("month");
  const [annualAvailable, setAnnualAvailable] = React.useState(false);
  const [busy, setBusy] = React.useState(null);
  const [err, setErr] = React.useState(null);

  React.useEffect(() => {
    api.subscription().then((v) => setAnnualAvailable(!!v?.annualAvailable)).catch(() => {});
  }, []);

  const choose = async (id) => {
    setErr(null);
    if (id === "free") { onChooseFree(); return; }
    setBusy(id);
    try {
      const { url } = await api.checkout(id, billInterval, { onboarding: true });
      window.location.href = url;
    } catch (e) {
      setErr(e?.message || "Couldn't start checkout. Is billing configured?");
      setBusy(null);
    }
  };

  return (
    <>
      <div className="ob-eyebrow">step 01 / plan</div>
      <h1 className="ob-title">Choose the plan that fits your team.</h1>
      <p className="ob-desc">
        Every paid plan starts with a 14-day free trial — full access now, no charge until day 14,
        cancel anytime. You can change or cancel your plan later in Settings.
      </p>

      {annualAvailable && (
        <div className="flex items-center" style={{ gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", gap: 4, padding: 4, border: "1px solid var(--border)", borderRadius: 10 }}>
            <button className={`btn ${billInterval === "month" ? "" : "ghost"}`}
              style={{ padding: "6px 14px" }} onClick={() => setBillInterval("month")}>Monthly</button>
            <button className={`btn ${billInterval === "year" ? "" : "ghost"}`}
              style={{ padding: "6px 14px" }} onClick={() => setBillInterval("year")}>Annual</button>
          </div>
          <span className="pill ok"><i className="dot"></i> Save 20% with annual billing</span>
        </div>
      )}

      <div className="plan-grid">
        {PLANS.map((p) => {
          const annual = billInterval === "year" && p.annual ? p.annual : null;
          const price = annual ? annual.price : p.price;
          const unit = annual ? annual.unit : p.unit;
          const note = annual ? annual.note : (p.reassure || "");
          const cta = p.id === "free" ? "Continue with Free" : "Start 14-day trial";
          return (
            <div key={p.id} className={`plan${p.featured ? " featured" : ""}`}>
              {p.featured ? <span className="pill purple plan-badge">popular</span> : null}
              <div className="plan-icon"><Icon name={p.icon} size={18} /></div>
              <div className="plan-name">{p.name}</div>
              <div className="plan-tag">{p.tagline}</div>
              <div className="plan-price">
                {annual && <span style={{ textDecoration: "line-through", opacity: 0.55, marginRight: 6, fontWeight: 400 }}>{annual.original}</span>}
                <b>{price}</b><span className="plan-unit">{unit}</span>
              </div>
              <div className="plan-note">{note}</div>
              <button
                className={`btn lg plan-cta ${p.id === "free" ? "ghost" : "primary"}`}
                disabled={busy === p.id}
                onClick={() => choose(p.id)}
              >
                {busy === p.id ? "Starting…" : cta}
              </button>
              <ul className="plan-feats">
                {p.features.map((f) =>
                  <li key={f} className="plan-feat"><Icon name="check" size={13} /><span>{f}</span></li>)}
              </ul>
            </div>
          );
        })}
      </div>
      {err && <div className="mute" style={{ color: "var(--danger)", fontSize: 12, marginTop: 12 }}>{err}</div>}
    </>
  );
};


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

const OBGitHub = ({ install, setInstall, refreshInstalls, isPaid }) => {
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
      <div className="ob-eyebrow">step 02 / github</div>
      <h1 className="ob-title">Configure the DevAsign GitHub App.</h1>
      <p className="ob-desc">
        DevAsign reads PR diffs and posts inline review comments through a GitHub App you
        install on your personal account or organization. Pick which repositories the app
        can see on GitHub — that's the source of truth.
      </p>

      <p className="mono" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.6, color: isPaid ? "var(--fg-mute)" : "var(--warn)" }}>
        {isPaid
          ? "Your plan reviews public and private repositories."
          : "Free reviews public repositories only — private repos need Pro. You can still grant private repos, but they won't be reviewed until you upgrade."}
      </p>

      {status !== "installed" ? (
        <GHInstallPanel status={status} onLaunch={launchGitHub} />
      ) : (
        <GHRepoBrowser
          accounts={accounts}
          onReconfigure={launchGitHub}
          totalRepos={totalRepos}
          isPaid={isPaid}
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

const GHRepoBrowser = ({ accounts, onReconfigure, totalRepos, isPaid }) => (
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

          {acct.shared && (
            // Another org owner already installed DevAsign on this org — tell the
            // user up front so they're not confused to find it already there.
            <div className="mono" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--fg-mute)", padding: "8px 12px", borderRadius: 8, background: "var(--bg-2)", margin: "0 0 8px" }}>
              <Icon name="check" size={11} color="var(--accent)"/>{" "}
              DevAsign is already installed on <b>{acct.login}</b> by an organization owner — you have
              access to these repositories.
            </div>
          )}

          <ul className="gh-repo-list">
            {acct.repos.map((r) => {
              const noReview = !isPaid && r.visibility === "private";
              return (
                <li key={r.name} className="gh-repo-row">
                  <Icon name="git" size={11} color="var(--fg-faint)"/>
                  <span className="mono gh-repo-name">{r.name}</span>
                  <span className="gh-repo-meta mono">
                    {r.lang} · {r.prs.toLocaleString()} PRs
                  </span>
                  <span className="flex-1"></span>
                  {noReview ? (
                    <span className="pill warn mono" style={{ fontSize: 10 }}>private · won't review on Free</span>
                  ) : (
                    <span className={`gh-repo-vis mono ${r.visibility}`}>{r.visibility}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  </>
);

const OBInteg = ({ integ, setInteg }) => {
  const items = [
    { key: "linear",  icon: "linear",  name: "Linear",  desc: "Auto-pull goal context from the linked ticket on PR open." },
  ];

  // Linear is a Pro/Max feature; the backend 403s free users. We surface a
  // Pro/Max lock instead of a Connect button for them (gated on planKnown so a
  // paid user doesn't flash the lock before /api/me resolves).
  const { user, status } = useAuth();
  const planKnown = status === "signed_in";
  const isFree = (user?.plan || "free") === "free";

  const [busy, setBusy] = React.useState(null);  // key currently being connected/disconnected
  const [rows, setRows] = React.useState([]);    // /api/integrations response
  // Inline error for the Linear OAuth round-trip, set when the popup posts
  // devasign_linear_done {ok:false}.
  const [linearError, setLinearError] = React.useState(false);

  // Hydrate connection state from the backend. Reused after an OAuth connect so
  // the card flips to "connected" once the integration row lands.
  const refresh = React.useCallback(async () => {
    try {
      const list = await api.integrations();
      setRows(list);
      setInteg({ linear: list.some((r) => r.type === "linear") });
    } catch {
      /* leave current state on a transient failure */
    }
  }, [setInteg]);
  React.useEffect(() => { refresh(); }, [refresh]);

  // Linear connects via an OAuth popup; main.tsx posts devasign_linear_done when
  // the callback lands back on our origin. Close the popup, then either refresh to
  // pick up the new integration row (ok) or surface an inline error (!ok).
  React.useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data;
      if (!d || d.type !== "devasign_linear_done") return;
      closePopup("linear");
      setBusy(null);
      if (d.ok === false) setLinearError(true);
      else { setLinearError(false); setTimeout(refresh, 400); }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [refresh]);

  // Connect = open the Linear OAuth popup (whole-workspace auth, same flow as
  // Settings → Integrations); disconnect = drop the integration row. Free users
  // never reach the connect path — the card renders a Pro/Max lock instead.
  const toggle = async (key) => {
    if (busy) return;
    if (integ[key]) {
      setBusy(key);
      try {
        const row = rows.find((r) => r.type === key);
        if (row) {
          await api.removeIntegration(row.id);
          setRows((rs) => rs.filter((r) => r.id !== row.id));
        }
        setInteg({ ...integ, [key]: false });
      } catch (err) {
        alert(`Disconnect failed: ${err.message || err}`);
      } finally {
        setBusy(null);
      }
      return;
    }
    // A fresh attempt clears any prior inline error. Open the backend authorize
    // endpoint in a popup; the message listener above refreshes on return.
    setLinearError(false);
    const popup = window.open(
      linearConnectUrl,
      "devasign_linear",
      "width=920,height=780,menubar=no,toolbar=no,location=yes"
    );
    if (!popup) { window.location.href = linearConnectUrl; return; } // popup blocked
    registerPopup("linear", popup);
    popup.focus();
    setBusy(key);
    // Fallback: if the user closes the popup before the message lands, stop the
    // spinner and refresh anyway when it closes.
    const watch = setInterval(() => {
      if (popup.closed) {
        clearInterval(watch);
        setBusy((b) => (b === key ? null : b));
        refresh();
      }
    }, 500);
  };

  return (
    <>
      <div className="ob-eyebrow">step 02 / integrations</div>
      <h1 className="ob-title">Wire DevAsign into where you already work.</h1>
      <p className="ob-desc">
        Optional. Connect Linear so the agent can auto-pull goal context from the
        linked ticket when a PR opens.
      </p>

      <div className="integ-list">
        {items.map(it => {
          const connected = integ[it.key];
          const locked = !connected && planKnown && isFree;
          return (
            <div key={it.key} className={`integ ${connected ? "connected" : ""}`}>
              <div className="integ-icon"><Icon name={it.icon} size={16}/></div>
              <div>
                <div className="integ-name">{it.name}</div>
                <div className="integ-desc">{it.desc}</div>
              </div>
              <span className={`pill ${connected ? "ok" : ""}`}>
                {connected ? <><i className="dot"></i> connected</> : locked ? "Pro · Max" : "not connected"}
              </span>
              {locked ? (
                // Linear is Pro/Max only — show a disabled Connect so the row keeps
                // its shape; the pill + the note below explain why. Connecting
                // happens later from Settings once they upgrade.
                <button className="btn" disabled style={{ opacity: 0.4, cursor: "not-allowed", whiteSpace: "nowrap" }}>
                  Connect
                </button>
              ) : (
                <button
                  className={`btn ${connected ? "ghost" : ""}`}
                  onClick={() => toggle(it.key)}
                  disabled={busy === it.key}
                >
                  {busy === it.key ? "…" : connected ? "Disconnect" : "Connect"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {linearError && (
        <div className="mono txt-danger" style={{ fontSize: 11, marginTop: 10 }}>
          Couldn't connect Linear — the authorization didn't complete. Click Connect to try again.
        </div>
      )}
      {planKnown && isFree && (
        <p className="mute mono" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
          Linear is a Pro &amp; Max feature — connect it any time from Settings → Integrations after upgrading.
        </p>
      )}
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
