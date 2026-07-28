// @ts-nocheck
// Main App shell + sidebar + routing
import React from "react";
import { useLocation, useNavigate, Routes, Route, Navigate } from "react-router-dom";
import { StatsigProvider, useClientAsyncInit } from "@statsig/react-bindings";
import { StatsigAutoCapturePlugin } from "@statsig/web-analytics";
import { StatsigSessionReplayPlugin } from "@statsig/session-replay";
import { Icon } from "./icons";
import { useTweaks, TweaksPanel, TweakSection, TweakColor, TweakRadio, TweakSelect } from "./tweaks-panel";
import { Auth, Onboarding } from "./screens-onboarding";
import { AgentPage } from "./screen-agent";
import { WorkflowPage } from "./screen-workflow";
import { BountiesPage } from "./screen-bounties";
import { FundBountyPage } from "./screen-fund-bounty";
import { SettingsPage } from "./screens-rest";
import { SecurityPage } from "./screen-security";
import { useAuth } from "./auth-context";
import { api, oauthStartUrl } from "./api";
import { LiveProvider, useLiveTopic } from "./live-context";
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
  { key: "agent",     name: "Agents",    icon: "agent" },
  { key: "workflow",  name: "Workflow",  icon: "workflow" },
  { key: "security",  name: "Security",  icon: "shield" },
  { key: "bounty",    name: "Bounty",    icon: "bounties" },
];

const Sidebar = ({ current, setCurrent, iconOnly, user }) => {
  const recents = useRecentReviews(user?.id, 3);
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
      <div className="sb-foot-text col" style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: "var(--fg)", fontSize: 12 }}>{user?.githubLogin || "unknown"}</span>
        <span style={{ fontSize: 10 }}>{user?.plan || "free"}</span>
      </div>
    </div>
  </div>
  );
};

const NOTIF_DOT = {
  review:  "var(--info)",
  blocker: "var(--danger)",
  system:  "var(--fg-mute)",
};

// Compact relative-time formatter for the notification row. Mirrors the
// pre-formatted strings the mock data used ("2m", "3h", "yesterday", "1w").
function ago(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7)  return `${d}d`;
  const w = Math.floor(d / 7);
  return `${w}w`;
}

// Live notifications via a Server-Sent Events stream: the backend pushes a
// "changed" signal the moment a notification is created (or marked read) and we
// refetch on it, so there's no steady polling. A slow 60s fallback poll is kept
// as a backstop for a dropped/blocked stream and the brief deploy window. The
// returned `markAllRead` flips every unread row server-side and updates local
// state optimistically so the badge clears without waiting for a refetch.
function useNotifications(enabled) {
  const [items, setItems] = React.useState([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const refresh = React.useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await api.notifications();
      setItems(data.items);
      setUnreadCount(data.unreadCount);
    } catch (err) {
      // 401 is normal on the auth screen; everything else is worth a console.
      if (!(err && (err.status === 401))) {
        console.warn("[notifications] poll failed:", err);
      }
    }
  }, [enabled]);
  useLiveTopic("notifications", () => void refresh());
  React.useEffect(() => {
    if (!enabled) {
      setItems([]);
      setUnreadCount(0);
      return;
    }
    // Paint immediately on mount/sign-in; LiveProvider drives every refresh after
    // that. The connection, the fallback poll and the tab-visible refetch all
    // moved there — one stream per tab, shared with the review queue and the
    // bounties screen instead of one per consumer.
    void refresh();
  }, [enabled, refresh]);
  const markAllRead = React.useCallback(async () => {
    // Optimistic: clear the badge + flip each row, then confirm server-side.
    const now = Date.now();
    setItems((prev) => prev.map((n) => (n.readAt === null ? { ...n, readAt: now } : n)));
    setUnreadCount(0);
    try {
      await api.markNotificationsRead();
    } catch (err) {
      console.warn("[notifications] markAllRead failed:", err);
      // Roll back by re-fetching; next poll will fix it anyway.
      refresh();
    }
  }, [refresh]);
  return { items, unreadCount, refresh, markAllRead };
}

const NotificationsPopover = ({ onClose, items, unreadCount, onMarkAllRead, onNavigate }) => {
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
  const handleRowClick = (n) => {
    // Clicks navigate to the agent page for now; review-level deep-link is
    // a follow-up. We always close the popover so the user lands on content.
    if (onNavigate) onNavigate("agent");
    onClose();
  };
  return (
    <div ref={ref} className={`notif-pop ${expanded ? "expanded" : ""}`} role="dialog" aria-label="Notifications">
      <div className="notif-pop-head">
        <span className="notif-pop-title">notifications</span>
        <span className="notif-pop-count">{unreadCount} new</span>
      </div>
      <div className="notif-pop-list">
        {items.length === 0 && (
          <div className="notif-row" style={{ opacity: 0.6 }}>
            <i className="notif-dot" style={{ background: "var(--fg-mute)" }}></i>
            <div className="notif-body">
              <div className="notif-title">No notifications yet</div>
              <div className="notif-meta">New PRs and completed reviews will appear here.</div>
            </div>
          </div>
        )}
        {items.map(n => {
          const unread = n.readAt === null;
          return (
            <div
              key={n.id}
              className={`notif-row ${unread ? "unread" : ""}`}
              onClick={() => handleRowClick(n)}
              style={{ cursor: "pointer" }}
            >
              <i className="notif-dot" style={{ background: NOTIF_DOT[n.kind] || NOTIF_DOT.system }}></i>
              <div className="notif-body">
                <div className="notif-title">{n.title}</div>
                <div className="notif-meta">{n.meta}</div>
              </div>
              <div className="notif-time">{ago(n.createdAt)}</div>
            </div>
          );
        })}
      </div>
      <div className="notif-pop-foot">
        <button className="notif-foot-btn" onClick={onMarkAllRead}>Mark all read</button>
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

const TopBar = ({ current, isMobile, onSignOut, onNavigate, user, notifications, workflowRepo, securityCrumbs, onCrumbNavigate }) => {
  const labels = {
    agent: "Agents", workflow: "Workflow", bounty: "Bounty", security: "Security", settings: "Settings"
  };
  // On the Workflow page the selected repo becomes the final crumb:
  // user / Workflow / repo-name.
  const showRepoCrumb = current === "workflow" && !!workflowRepo;
  // On the Security page the sub-view (and, inside a finding, where it was opened
  // from) becomes a clickable trail: user / Security / Merge gate / VLN-… — each
  // earlier segment navigates back. Reported by the screen via onCrumbs.
  const showSecurityTrail = current === "security" && Array.isArray(securityCrumbs) && securityCrumbs.length > 0;
  const [notifOpen, setNotifOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);
  const unread = notifications?.unreadCount ?? 0;
  return (
    <div className="topbar">
      {isMobile && (
        <img src={(typeof window !== "undefined" && window.__resources && window.__resources.logo) || "devasign-logo.svg"} alt="DevAsign" className="topbar-logo" />
      )}
      <div className="crumbs">
        <span>{user?.githubLogin || "workspace"}</span><span className="sep">/</span>
        {showSecurityTrail ? (
          securityCrumbs.map((c, i) => {
            const isLast = i === securityCrumbs.length - 1;
            return (
              <React.Fragment key={i}>
                {i > 0 && <span className="sep">/</span>}
                {c.path && !isLast ? (
                  <span className="crumb-link" onClick={() => onCrumbNavigate(c.path)}>{c.label}</span>
                ) : (
                  <span className={isLast ? "now" : ""}>{c.label}</span>
                )}
              </React.Fragment>
            );
          })
        ) : showRepoCrumb ? (
          <>
            {!isMobile && <><span>{labels[current]}</span><span className="sep">/</span></>}
            <span className="now">{workflowRepo}</span>
          </>
        ) : (
          <span className="now">{labels[current]}</span>
        )}
      </div>
      <div className="topbar-spacer"></div>
      <div className="topbar-actions">
        <div style={{ position: "relative" }}>
          <button className={`btn ghost sm ${notifOpen ? "is-active" : ""}`}
                  style={{ position: "relative" }}
                  onClick={() => setNotifOpen(o => !o)}
                  aria-label="Notifications">
            <Icon name="bell" size={13}/>
            {unread > 0 && (
              <i
                aria-label={`${unread} unread notification${unread === 1 ? "" : "s"}`}
                style={{ position: "absolute", top: 5, right: 6, width: 6, height: 6, background: "var(--accent)", borderRadius: "50%" }}
              ></i>
            )}
          </button>
          {notifOpen && (
            <NotificationsPopover
              onClose={() => setNotifOpen(false)}
              items={notifications?.items || []}
              unreadCount={unread}
              onMarkAllRead={notifications?.markAllRead}
              onNavigate={onNavigate}
            />
          )}
        </div>
        <button
          className={`btn ghost sm ${current === "settings" ? "is-active" : ""}`}
          onClick={() => onNavigate?.("settings")}
          aria-label="Settings">
          <Icon name="settings" size={13}/>
        </button>
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

const AppContent = () => {
  const auth = useAuth();
  // stage = auth | onboarding | app — derived from signed-in state + whether
  // the user has any GitHub App installations linked. `force` lets the user
  // re-enter onboarding from settings if they want to add another install.
  const [forceStage, setForceStage] = React.useState<null | "onboarding" | "app">(null);
  const [hasInstall, setHasInstall] = React.useState<null | boolean>(null);
  // The visible page is derived from the URL rather than held in state. `current`
  // is the first path segment (agent|workflow|bounty|settings, default agent);
  // `setCurrent` is a shim that navigates, so every existing setCurrent(key) call
  // site (sidebar, mobile tabs, popovers, keyboard chords) keeps working unchanged.
  const location = useLocation();
  const navigate = useNavigate();
  const PAGE_KEYS = ["agent", "workflow", "bounty", "security", "settings"];
  const rawSeg = location.pathname.split("/")[1];
  // The bounty deep links from the bot comment (/bounties/:id/fund|cancel|apply)
  // are PLURAL, so they miss the singular nav key and would fall through to the
  // "agent" default — highlighting the wrong sidebar item on arrival.
  const seg = rawSeg === "bounties" ? "bounty" : rawSeg;
  const current = PAGE_KEYS.includes(seg) ? seg : "agent";
  const setCurrent = React.useCallback((key) => navigate("/" + key), [navigate]);
  // The Workflow screen's selected repo name, surfaced for the header breadcrumb
  // (WorkflowPage reports it via onRepoChange).
  const [workflowRepo, setWorkflowRepo] = React.useState<string | null>(null);
  // The Security screen's breadcrumb trail (Security → Merge gate → finding …),
  // reported via onCrumbs so the header reflects navigation within the section.
  const [securityCrumbs, setSecurityCrumbs] = React.useState(null);
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const isMobile = useIsMobile();
  const notifications = useNotifications(auth.status === "signed_in");

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
    // If the full-page sign-in started from a deep link (stashed by
    // signInPopup's blocked-popup branch), return the user there.
    try {
      const returnTo = localStorage.getItem("devasign_return_to");
      if (returnTo) {
        localStorage.removeItem("devasign_return_to");
        if (returnTo.startsWith("/")) navigate(returnTo, { replace: true });
      }
    } catch { /* storage unavailable — stay on the default page */ }
    auth.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Top-level fallback for the Linear connect round-trip. If popups were blocked,
  // /api/auth/linear/callback redirected the whole tab to /?linear=connected|error.
  // On success just strip the marker (Integrations/Repository tabs refresh on mount).
  // On error, route to Settings → Integrations, which reads ?linear=error for its
  // inline notice and strips the marker itself.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const linear = url.searchParams.get("linear");
    if (linear === "connected") {
      url.searchParams.delete("linear");
      window.history.replaceState({}, "", url.pathname + url.search);
    } else if (linear === "error") {
      navigate("/settings/integrations", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Return from Stripe Checkout/Portal (or an "upgrade" link from a PR comment):
  // /?billing=success|cancel|portal|upgrade. Strip the marker, reload the
  // session (the webhook may have changed the plan), and open Settings → Billing.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.get("billing")) return;
    url.searchParams.delete("billing");
    window.history.replaceState({}, "", url.pathname + url.search);
    auth.reload();
    navigate("/settings/billing", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Return from an onboarding-initiated Stripe Checkout. Unlike `?billing=...`
  // (which opens Settings → Billing), `?ob=billing` keeps the user in onboarding:
  // we just reload the session so the now-paid plan is reflected, and the
  // Onboarding component auto-advances from pricing to the repository step.
  // `?ob=cancel` returns them to the pricing step (still on Free).
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const ob = url.searchParams.get("ob");
    if (ob !== "billing" && ob !== "cancel") return;
    url.searchParams.delete("ob");
    window.history.replaceState({}, "", url.pathname + url.search);
    if (ob === "billing") auth.reload();
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
      } else if (data.type === "devasign_linear_done") {
        // Guarantee the popup closes regardless of which screen is mounted; the
        // Integrations/Repository tabs refresh their own Linear data on this same
        // message via their local listeners.
        closePopup("linear");
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
      // Full-page OAuth loses the current URL (the callback redirects to
      // /?auth=ok) — stash it so the return effect can put the user back,
      // e.g. on a bounty apply/fund deep link they arrived on signed out.
      try {
        localStorage.setItem("devasign_return_to", window.location.pathname + window.location.search);
      } catch { /* storage unavailable — worst case we land on the default page */ }
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
  const [stage, setStage] = React.useState<"loading" | "auth" | "unavailable" | "onboarding" | "app">("loading");
  React.useEffect(() => {
    if (auth.status === "loading") { setStage("loading"); return; }
    if (auth.status === "signed_out") { setStage("auth"); return; }
    // Valid session the backend couldn't resolve (likely data loss on redeploy).
    // Show a retry screen, NOT sign-in — re-auth here would orphan the account.
    if (auth.status === "unavailable") { setStage("unavailable"); return; }
    // Bounty deep links (the bot comment's Apply CTA, and the sponsor's
    // Fund/Cancel links) must render for ANY signed-in user — a contributor
    // has no GitHub App installation and would otherwise be trapped in
    // onboarding, never reaching the page the link points at. The signed-in
    // check is already guaranteed by the early returns above; it's restated
    // here so the bypass can never leak the app shell to a signed-out visitor
    // if those returns are ever reordered.
    if (
      auth.status === "signed_in" &&
      /^\/bounties\/[^/]+\/(apply|fund|cancel)$/.test(location.pathname)
    ) {
      setStage("app");
      return;
    }
    if (forceStage) { setStage(forceStage); return; }
    setStage((s) => {
      // Sticky: once in onboarding or app, stay there until forceStage moves us.
      if (s === "onboarding" || s === "app") return s;
      if (hasInstall === null) return "loading";
      return hasInstall ? "app" : "onboarding";
    });
  }, [auth.status, hasInstall, forceStage, location.pathname]);

  // Apply tweaks
  React.useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent", t.accent);
    // derive accent-dim/glow
    root.style.setProperty("--accent-glow", t.accent + "26");
    root.style.setProperty("--mono", FONT_OPTIONS[t.mono] || FONT_OPTIONS["Geist Mono"]);
  }, [t.accent, t.mono]);

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

  // Valid session, account temporarily unresolvable (503 account_unavailable).
  // Deliberately NOT the sign-in screen: signing in again would mint a fresh
  // account and orphan the real one. Offer a retry; the session is preserved, so
  // once the backend's store is restored a reload signs the user straight back in.
  if (stage === "unavailable") {
    return (
      <div className="auth-shell" style={{ display: "grid", placeItems: "center", textAlign: "center" }}>
        <div style={{ maxWidth: 420, padding: 24 }}>
          <h2 style={{ marginBottom: 8 }}>Your account is temporarily unavailable</h2>
          <p className="mute" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
            You’re still signed in, but we couldn’t load your account just now. This is usually
            temporary — please try again in a moment. Your data hasn’t been deleted.
          </p>
          <button className="btn primary" onClick={() => auth.reload()}>Try again</button>
        </div>
      </div>
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
          isMobile={isMobile}
          onSignOut={async () => {
            await auth.signOut();
            setForceStage(null);
            setHasInstall(null);
          }}
          onNavigate={(k) => setCurrent(k)}
          user={auth.user}
          notifications={notifications}
          workflowRepo={workflowRepo}
          securityCrumbs={securityCrumbs}
          onCrumbNavigate={(path) => navigate(path)}
        />
        <div className="content" style={current === "agent" || current === "workflow" ? { overflow: "hidden", display: "flex", flexDirection: "column" } : {}}>
          <Routes>
            <Route path="/agent"    element={<AgentPage logStyle={t.logStyle} isMobile={isMobile} />} />
            <Route path="/workflow" element={<WorkflowPage onRepoChange={setWorkflowRepo} />} />
            <Route path="/bounty"   element={<BountiesPage isMobile={isMobile} />} />
            <Route path="/bounties/:id/fund" element={<FundBountyPage />} />
            <Route path="/bounties/:id/cancel" element={<BountiesPage isMobile={isMobile} isCancelling />} />
            <Route path="/security" element={<SecurityPage view="dashboard" isMobile={isMobile} onCrumbs={setSecurityCrumbs} />} />
            <Route path="/security/findings/:findingId" element={<SecurityPage view="detail" isMobile={isMobile} onCrumbs={setSecurityCrumbs} />} />
            <Route path="/security/gate" element={<SecurityPage view="gate" isMobile={isMobile} onCrumbs={setSecurityCrumbs} />} />
            <Route path="/security/policy" element={<SecurityPage view="policy" isMobile={isMobile} onCrumbs={setSecurityCrumbs} />} />
            <Route path="/settings" element={<Navigate to="/settings/account" replace />} />
            <Route path="/settings/:section" element={<SettingsPage />} />
            <Route path="/" element={<Navigate to="/agent" replace />} />
            <Route path="*" element={<Navigate to="/agent" replace />} />
          </Routes>
        </div>
      </div>
      {isMobile && <MobileTabBar current={current} setCurrent={setCurrent} />}
      <TweaksUI t={t} setTweak={setTweak} />
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

const STATSIG_ANON_ID = "a-user";

const App = () => {
  const auth = useAuth();
  const { client } = useClientAsyncInit(
    "client-cBOBwEpbz8xXWVxibGwwth6hoDZFc4TfLNpQlA3BFMw",
    { userID: STATSIG_ANON_ID },
    { plugins: [new StatsigAutoCapturePlugin(), new StatsigSessionReplayPlugin()] }
  );

  // Keep the Statsig identity in sync with the session. useClientAsyncInit
  // ignores changes to its user argument, so identity moves through
  // updateUserAsync: the real id once /api/me resolves, the anonymous id
  // again after sign-out.
  const statsigUserId = React.useRef(STATSIG_ANON_ID);
  React.useEffect(() => {
    if (auth.status === "loading") return;
    const id = auth.user?.id || STATSIG_ANON_ID;
    if (id === statsigUserId.current) return;
    statsigUserId.current = id;
    client
      .updateUserAsync({ userID: id })
      .catch((err) => console.warn("[statsig] updateUser failed:", err));
  }, [auth.status, auth.user?.id, client]);

  // LiveProvider wraps AppContent rather than living inside it: AppContent
  // early-returns for loading / auth / unavailable / onboarding, so mounting the
  // provider in there would tear down and re-open the SSE connection on every
  // stage flip — including onboarding→app, the moment a user finishes setup.
  // Out here it survives all of them, and it gates itself on auth internally.
  return (
    <StatsigProvider client={client} loadingComponent={<div>Loading...</div>}>
      <LiveProvider>
        <AppContent />
      </LiveProvider>
    </StatsigProvider>
  );
};

export { App };
export default App;
