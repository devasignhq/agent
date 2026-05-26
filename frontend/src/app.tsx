// @ts-nocheck
// Main App shell + sidebar + routing
import React from "react";
import { Icon } from "./icons";
import { useTweaks, TweaksPanel, TweakSection, TweakColor, TweakRadio, TweakSelect } from "./tweaks-panel";
import { Auth, Onboarding } from "./screens-onboarding";
import { AgentPage } from "./screen-agent";
import { SettingsPage } from "./screens-rest";
import { CommandCenter } from "./command-center";
import { useAuth } from "./auth-context";
import { api, oauthStartUrl } from "./api";
import { registerPopup, closePopup } from "./popup-registry";
import { useRecentReviews } from "./recent-reviews";

const MOBILE_BREAKPOINT = 820;
const useIsMobile = () => {
  const [m, setM] = React.useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT
  );
  React.useEffect(() => {
    const onR = () => setM(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, []);
  return m;
};
export { useIsMobile };

const NAV = [
  { key: "agent",     name: "Agents",    icon: "agent",     kbd: "g a" },
  { key: "settings",  name: "Settings",  icon: "settings",  kbd: "g s" },
];

const Sidebar = ({ current, setCurrent, iconOnly, user }) => {
  const recents = useRecentReviews(3);
  return (
  <div className={`sidebar ${iconOnly ? "icon-only" : ""}`}>
    <div className="sb-head">
      <img src={(typeof window !== "undefined" && window.__resources && window.__resources.logo) || "devasign-logo.svg"} alt="DevAsign" className="sb-logo-img" />
    </div>

    <div className="sb-section">workspace</div>
    <div className="sb-list">
      {NAV.map(n => (
        <div key={n.key}
             className={`sb-item ${current === n.key ? "active" : ""}`}
             onClick={() => setCurrent(n.key)}>
          <span className="icon"><Icon name={n.icon} size={15}/></span>
          <span className="sb-label">{n.name}</span>
          <span className="kbd">{n.kbd}</span>
        </div>
      ))}
    </div>

    <div className="sb-section">recent</div>
    <div className="sb-list">
      {recents.length === 0 ? (
        <div className="sb-item" style={{ opacity: 0.5, cursor: "default" }}>
          <span className="sb-label" style={{ fontSize: 12 }}>No recent reviews</span>
        </div>
      ) : recents.map((r) => (
        <div key={r.id} className="sb-item" onClick={() => setCurrent("agent")} title={r.title}>
          <span className="icon">
            <i style={{
              width: 6, height: 6,
              background: r.flag === "blocker" ? "var(--danger)" : r.flag === "review" ? "var(--warn)" : "var(--accent)"
            }}></i>
          </span>
          <span className="sb-label mono" style={{ fontSize: 12 }}>{`${r.repo.split("/").pop()}/${r.uiId}`}</span>
        </div>
      ))}
    </div>

    <div className="sb-foot">
      <div className="sb-avatar">
        {user?.avatarUrl ? <img src={user.avatarUrl} alt="" style={{ width: "100%", height: "100%", borderRadius: "inherit", objectFit: "cover" }}/> : (user?.githubLogin || "?").charAt(0).toUpperCase()}
      </div>
      <div className="sb-foot-text col" style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: "var(--fg)", fontSize: 12 }}>{user?.githubLogin || "unknown"}</span>
        <span style={{ fontSize: 10 }}>{user?.plan || "free"} · github</span>
      </div>
    </div>
  </div>
  );
};

const NOTIFICATIONS = [
  { id: 1, kind: "review", title: "PR #482 ready for review", meta: "acme/pay · agent", time: "2m", unread: true },
  { id: 4, kind: "blocker", title: "Agent flagged a blocker", meta: "acme/admin#1142",        time: "3h", unread: false },
  { id: 6, kind: "review", title: "PR #471 merged into main",  meta: "acme/pay · @maya",       time: "yesterday", unread: false },
  { id: 8, kind: "system", title: "Slack workspace connected", meta: "integrations",            time: "2d", unread: false },
  { id: 9, kind: "review", title: "Comment from @jules on PR #468", meta: "acme/admin · 1 reply", time: "3d", unread: false },
  { id: 11, kind: "blocker", title: "CI failed on acme/infra#313", meta: "build · timeout",    time: "5d", unread: false },
  { id: 12, kind: "system", title: "New device signed in",      meta: "Chrome · macOS",         time: "1w", unread: false },
];

const NOTIF_DOT = {
  review:  "var(--info)",
  blocker: "var(--danger)",
  system:  "var(--fg-mute)",
};

const NotificationsPopover = ({ onClose }) => {
  const ref = React.useRef(null);
  const [expanded, setExpanded] = React.useState(false);
  React.useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    // defer so the click that opened us doesn't immediately close us
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [onClose]);
  const unread = NOTIFICATIONS.filter(n => n.unread).length;
  return (
    <div ref={ref} className={`notif-pop ${expanded ? "expanded" : ""}`} role="dialog" aria-label="Notifications">
      <div className="notif-pop-head">
        <span className="notif-pop-title">notifications</span>
        <span className="notif-pop-count">{unread} new</span>
      </div>
      <div className="notif-pop-list">
        {NOTIFICATIONS.map(n => (
          <div key={n.id} className={`notif-row ${n.unread ? "unread" : ""}`}>
            <i className="notif-dot" style={{ background: NOTIF_DOT[n.kind] }}></i>
            <div className="notif-body">
              <div className="notif-title">{n.title}</div>
              <div className="notif-meta">{n.meta}</div>
            </div>
            <div className="notif-time">{n.time}</div>
          </div>
        ))}
      </div>
      <div className="notif-pop-foot">
        <button className="notif-foot-btn">Mark all read</button>
        <button className="notif-foot-btn primary" onClick={() => setExpanded(e => !e)}>
          {expanded ? "Show less" : "View all"}
        </button>
      </div>
    </div>
  );
};

const USER_MENU = [
  { id: "settings", label: "Account settings", meta: "Profile · Billing",  icon: "settings", kind: "nav" },
  { id: "signout",  label: "Sign out",         meta: "End session",      icon: "logout",   kind: "danger" },
];

const UserPopover = ({ onClose, onSignOut, onNavigate, user }) => {
  const ref = React.useRef(null);
  const [confirming, setConfirming] = React.useState(false);
  React.useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const handle = (item) => {
    if (item.id === "signout") { setConfirming(true); return; }
    if (item.id === "settings") { onNavigate?.("settings"); onClose(); return; }
    onClose();
  };

  return (
    <div ref={ref} className="user-pop" role="menu" aria-label="Account">
      <div className="user-pop-head">
        <div className="user-pop-avatar">
          {user?.avatarUrl
            ? <img src={user.avatarUrl} alt="" style={{ width: "100%", height: "100%", borderRadius: "inherit", objectFit: "cover" }}/>
            : (user?.githubLogin || "?").charAt(0).toUpperCase()}
        </div>
        <div className="user-pop-id">
          <div className="user-pop-name">{user?.githubLogin || "Signed in"}</div>
          <div className="user-pop-mail">{user?.email || ""}</div>
        </div>
        <span className="user-pop-status" aria-label="Online"></span>
      </div>
      <div className="user-pop-org">
        <span className="user-pop-org-label">plan</span>
        <span className="user-pop-org-name">{user?.plan || "free"}</span>
        <span className="user-pop-org-role">github</span>
      </div>
      <div className="user-pop-list">
        {USER_MENU.map(item => (
          <React.Fragment key={item.id}>
            <button
              role="menuitem"
              className={`user-row ${item.kind === "danger" ? "danger" : ""} ${item.id === "signout" && confirming ? "is-confirming" : ""}`}
              onClick={() => handle(item)}
              aria-expanded={item.id === "signout" ? confirming : undefined}
            >
              <span className="user-row-ico"><Icon name={item.icon} size={13}/></span>
              <span className="user-row-body">
                <span className="user-row-label">{item.label}</span>
                <span className="user-row-meta">{item.meta}</span>
              </span>
              {item.kind === "danger"
                ? <span className="user-row-kbd">⇧⌘Q</span>
                : <span className="user-row-chev">›</span>}
            </button>
            {item.id === "signout" && confirming && (
              <div className="user-confirm" role="alertdialog" aria-label="Confirm sign out">
                <div className="user-confirm-msg">
                  Sign out of <span className="user-confirm-mail">{user?.email || user?.githubLogin || "this account"}</span>?
                  Any unsaved drafts will stay on this device.
                </div>
                <div className="user-confirm-actions">
                  <button
                    className="btn ghost sm"
                    onClick={() => setConfirming(false)}
                    autoFocus
                  >Cancel</button>
                  <button
                    className="btn sm user-confirm-go"
                    onClick={() => { setConfirming(false); onSignOut(); onClose(); }}
                  >
                    <Icon name="logout" size={11}/> Yes, sign out
                  </button>
                </div>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
      <div className="user-pop-foot">
        <span>v0.4.2 · build 8c1a</span>
        <span className="user-pop-foot-dot">●</span>
        <span>all systems normal</span>
      </div>
    </div>
  );
};

const TopBar = ({ current, onOpenCC, isMobile, onSignOut, onNavigate, user }) => {
  const labels = {
    agent: "Agents", settings: "Settings"
  };
  const [notifOpen, setNotifOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);
  return (
    <div className="topbar">
      {isMobile && (
        <img src={(typeof window !== "undefined" && window.__resources && window.__resources.logo) || "devasign-logo.svg"} alt="DevAsign" className="topbar-logo" />
      )}
      <div className="crumbs">
        <span>{user?.githubLogin || "workspace"}</span><span className="sep">/</span>
        <span className="now">{labels[current]}</span>
      </div>
      <div className="topbar-spacer"></div>
      <div className="topbar-actions">
        <button className="btn ghost sm topbar-search" onClick={onOpenCC} aria-label="Search">
          <Icon name="search" size={12}/>
          <span className="topbar-search-label"> Search </span>
          <span className="kbd-hint">⌘K</span>
        </button>
        <div style={{ position: "relative" }}>
          <button className={`btn ghost sm ${notifOpen ? "is-active" : ""}`}
                  style={{ position: "relative" }}
                  onClick={() => setNotifOpen(o => !o)}
                  aria-label="Notifications">
            <Icon name="bell" size={13}/>
            <i style={{ position: "absolute", top: 5, right: 6, width: 6, height: 6, background: "var(--accent)", borderRadius: "50%" }}></i>
          </button>
          {notifOpen && <NotificationsPopover onClose={() => setNotifOpen(false)} />}
        </div>
        <div style={{ position: "relative" }}>
          <button
            className={`sb-avatar avatar-btn ${userOpen ? "is-active" : ""}`}
            style={{ width: 28, height: 28 }}
            onClick={() => setUserOpen(o => !o)}
            aria-label="Account menu"
            aria-haspopup="menu"
            aria-expanded={userOpen}
          >
            {user?.avatarUrl
              ? <img src={user.avatarUrl} alt="" style={{ width: "100%", height: "100%", borderRadius: "inherit", objectFit: "cover" }}/>
              : (user?.githubLogin || "?").charAt(0).toUpperCase()}
          </button>
          {userOpen && (
            <UserPopover
              onClose={() => setUserOpen(false)}
              onSignOut={onSignOut}
              onNavigate={onNavigate}
              user={user}
            />
          )}
        </div>
      </div>
    </div>
  );
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#ff7a3d",
  "density": "regular",
  "sidebar": "labeled",
  "logStyle": "timeline",
  "mono": "Geist Mono"
}/*EDITMODE-END*/;

const FONT_OPTIONS = {
  "Geist Mono": "'Geist Mono', ui-monospace, monospace",
  "JetBrains Mono": "'JetBrains Mono', ui-monospace, monospace",
  "IBM Plex Mono": "'IBM Plex Mono', ui-monospace, monospace",
  "Berkeley Mono": "'Berkeley Mono', 'JetBrains Mono', ui-monospace, monospace",
  "Fira Code": "'Fira Code', ui-monospace, monospace",
};

const MobileTabBar = ({ current, setCurrent }) => (
  <nav className="mtab-bar" role="navigation" aria-label="Primary">
    <div className="mtab-glass" aria-hidden="true"></div>
    <div className="mtab-row">
      {NAV.map(n => (
        <button
          key={n.key}
          type="button"
          className={`mtab ${current === n.key ? "active" : ""}`}
          onClick={() => setCurrent(n.key)}
          aria-current={current === n.key ? "page" : undefined}
          aria-label={n.name}
        >
          <span className="mtab-icon"><Icon name={n.icon} size={19}/></span>
          <span className="mtab-label">{n.name}</span>
        </button>
      ))}
    </div>
  </nav>
);

const App = () => {
  const auth = useAuth();
  // stage = auth | onboarding | app — derived from signed-in state + whether
  // the user has any GitHub App installations linked. `force` lets the user
  // re-enter onboarding from settings if they want to add another install.
  const [forceStage, setForceStage] = React.useState<null | "onboarding" | "app">(null);
  const [hasInstall, setHasInstall] = React.useState<null | boolean>(null);
  const [current, setCurrent] = React.useState("agent");
  const [ccOpen, setCCOpen] = React.useState(false);
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const isMobile = useIsMobile();

  // Top-level fallback for the install round-trip: if popups were blocked and
  // we did a full-page nav, GitHub will have redirected back to the main tab
  // carrying ?installation_id=N&setup_action=install. (The popup path is
  // handled by main.tsx's handshake and won't trigger this code.)
  React.useEffect(() => {
    if (auth.status !== "signed_in") return;
    const url = new URL(window.location.href);
    const installationId = url.searchParams.get("installation_id");
    if (!installationId) return;
    api
      .linkInstallation(Number(installationId))
      .catch((err) => console.warn("[install] link failed", err))
      .finally(() => {
        url.searchParams.delete("installation_id");
        url.searchParams.delete("setup_action");
        url.searchParams.delete("state");
        window.history.replaceState({}, "", url.pathname + url.search);
        // Refresh the install gate so the UI advances to the app shell.
        api
          .installations()
          .then((list) => setHasInstall(list.length > 0))
          .catch(() => {});
      });
  }, [auth.status]);

  // Top-level fallback for the OAuth round-trip. If popups were blocked,
  // /api/auth/github/callback redirected the whole tab to /?auth=ok — reload
  // session and strip the marker.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("auth") !== "ok") return;
    url.searchParams.delete("auth");
    window.history.replaceState({}, "", url.pathname + url.search);
    auth.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Popup-completion listener: main.tsx postMessages us when an OAuth or
  // install popup finishes. We close the popup window from the opener side
  // (the popup itself can't reliably window.close() after navigating through
  // GitHub), then either reload the session or claim the install and refresh
  // the install gate so routing advances.
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data: any = e.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "devasign_auth_done") {
        closePopup("auth");
        auth.reload();
      } else if (data.type === "devasign_install_done" && typeof data.installationId === "number") {
        closePopup("install");
        api
          .linkInstallation(data.installationId)
          .catch((err) => console.warn("[install] link failed", err))
          .finally(() => {
            api
              .installations()
              .then((list) => setHasInstall(list.length > 0))
              .catch(() => {});
          });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [auth]);

  // Popup-aware sign-in: open the OAuth start URL in a small window. Falls
  // back to the top-level navigation if the browser blocks the popup.
  const signInPopup = React.useCallback(() => {
    const popup = window.open(
      oauthStartUrl,
      "devasign_auth",
      "width=620,height=760,menubar=no,toolbar=no,location=yes"
    );
    if (!popup) {
      auth.signIn();
      return;
    }
    registerPopup("auth", popup);
    popup.focus();
    // No UI state to revert here — the auth screen just stays visible until
    // the postMessage arrives. The opener-side listener above advances stage
    // and closes the popup via closePopup("auth").
  }, [auth]);

  // Decide whether to show onboarding or the app shell. Cheap: 1 GET on sign-in.
  React.useEffect(() => {
    if (auth.status !== "signed_in") {
      setHasInstall(null);
      return;
    }
    api
      .installations()
      .then((list) => setHasInstall(list.length > 0))
      .catch(() => setHasInstall(false));
  }, [auth.status]);

  // Stage = loading | auth | onboarding | app.
  // Initial derivation: auth → onboarding (if no install) → app (if install).
  // Once onboarding is entered it's sticky — we don't jerk the user out of
  // it just because /api/installations starts returning a row mid-flow. The
  // user leaves onboarding by clicking "Finish setup", which sets forceStage.
  const [stage, setStage] = React.useState<"loading" | "auth" | "onboarding" | "app">("loading");
  React.useEffect(() => {
    if (auth.status === "loading") { setStage("loading"); return; }
    if (auth.status === "signed_out") { setStage("auth"); return; }
    if (forceStage) { setStage(forceStage); return; }
    setStage((s) => {
      // Sticky: once in onboarding or app, stay there until forceStage moves us.
      if (s === "onboarding" || s === "app") return s;
      if (hasInstall === null) return "loading";
      return hasInstall ? "app" : "onboarding";
    });
  }, [auth.status, hasInstall, forceStage]);

  // Apply tweaks
  React.useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent", t.accent);
    // derive accent-dim/glow
    root.style.setProperty("--accent-glow", t.accent + "26");
    root.style.setProperty("--mono", FONT_OPTIONS[t.mono] || FONT_OPTIONS["Geist Mono"]);
  }, [t.accent, t.mono]);

  // Keyboard shortcuts: g + (a/d/b/w/s)
  React.useEffect(() => {
    let last = 0, lastKey = "";
    const onKey = (e) => {
      if (stage !== "app") return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const now = Date.now();
      if (e.key === "g") { lastKey = "g"; last = now; return; }
      if (lastKey === "g" && now - last < 800) {
        const map = { a: "agent", s: "settings" };
        if (map[e.key]) { setCurrent(map[e.key]); e.preventDefault(); }
        lastKey = "";
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage]);

  // ⌘K / Ctrl+K to toggle Command Center
  React.useEffect(() => {
    const onKey = (e) => {
      if (stage !== "app") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCCOpen(o => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage]);

  if (stage === "loading") {
    return (
      <div className="auth-shell" style={{ display: "grid", placeItems: "center" }}>
        <div className="mono mute" style={{ fontSize: 12 }}>loading…</div>
      </div>
    );
  }

  if (stage === "auth") {
    return (
      <>
        <Auth onSignIn={signInPopup} />
        <TweaksUI t={t} setTweak={setTweak} />
      </>
    );
  }

  if (stage === "onboarding") {
    return (
      <>
        <Onboarding
          onDone={() => {
            setForceStage("app");
            // Refresh install state so post-onboarding nav lands on the app.
            api
              .installations()
              .then((list) => setHasInstall(list.length > 0))
              .catch(() => {});
          }}
        />
        <TweaksUI t={t} setTweak={setTweak} />
      </>
    );
  }

  return (
    <div className={`app density-${t.density} ${isMobile ? "is-mobile" : ""}`}>
      {!isMobile && (
        <Sidebar current={current} setCurrent={setCurrent} iconOnly={t.sidebar === "icon-only"} user={auth.user} />
      )}
      <div className="main">
        <TopBar
          current={current}
          onOpenCC={() => setCCOpen(true)}
          isMobile={isMobile}
          onSignOut={async () => {
            await auth.signOut();
            setForceStage(null);
            setHasInstall(null);
          }}
          onNavigate={(k) => setCurrent(k)}
          user={auth.user}
        />
        <div className="content" style={current === "agent" ? { overflow: "hidden", display: "flex", flexDirection: "column" } : {}}>
          {current === "agent" && <AgentPage logStyle={t.logStyle} isMobile={isMobile} />}
          {current === "settings" && <SettingsPage />}
        </div>
      </div>
      {isMobile && <MobileTabBar current={current} setCurrent={setCurrent} />}
      <TweaksUI t={t} setTweak={setTweak} />
      <CommandCenter
        open={ccOpen}
        onClose={() => setCCOpen(false)}
        onNavigate={(k) => setCurrent(k)}
      />
    </div>
  );
};

const TweaksUI = ({ t, setTweak }) => (
  <TweaksPanel>
    <TweakSection label="Theme" />
    <TweakColor label="Accent" value={t.accent}
                options={["#ff7a3d", "#3ee07f", "#4aa8ff", "#a48cff", "#ffb84a", "#ff5a7d"]}
                onChange={v => setTweak("accent", v)} />
    <TweakSection label="Layout" />
    <TweakRadio  label="Density" value={t.density}
                 options={["compact", "regular", "cozy"]}
                 onChange={v => setTweak("density", v)} />
    <TweakRadio  label="Sidebar" value={t.sidebar}
                 options={["icon-only", "labeled"]}
                 onChange={v => setTweak("sidebar", v)} />
    <TweakSection label="Typography" />
    <TweakSelect label="Mono font" value={t.mono}
                 options={Object.keys(FONT_OPTIONS)}
                 onChange={v => setTweak("mono", v)} />
  </TweaksPanel>
);

export { App };
export default App;
