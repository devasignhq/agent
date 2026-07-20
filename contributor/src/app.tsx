// Contributor app shell: routes (public discovery → GitHub auth gate →
// dashboard / bounties / wallet), sidebar + topbar, mobile tab bar, and the
// live notifications bell. Ported from the design's c-app.jsx with real
// react-router routing in place of the demo stage machine.
import React from "react";
import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from "react-router-dom";
import { Analytics } from '@vercel/analytics/react';
import { api, apiBase } from "./api";
import type { AppNotification, User } from "./api";
import { useAuth } from "./auth-context";
import { BountiesProvider, useBounties } from "./data-context";
import { LiveProvider, useLiveTopic } from "./live-context";
import { Icon } from "./icons";
import { FLAGS } from "./flags";
import { Discovery } from "./discovery";
import { AuthGate } from "./auth-gate";
import { Dashboard } from "./dashboard";
import { BountiesPage } from "./bounties";
import { WalletPage } from "./wallet";
import { SettingsPage } from "./settings";
import { bountyStage, STAGE_LABEL } from "./model.ts";

const MOBILE_BP = 820;
function useIsMobile(): boolean {
  const [m, setM] = React.useState(() => typeof window !== "undefined" && window.innerWidth < MOBILE_BP);
  React.useEffect(() => {
    const onR = () => setM(window.innerWidth < MOBILE_BP);
    onR();
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, []);
  return m;
}

const NAV: Array<{ key: string; name: string; icon: string }> = [
  { key: "dashboard", name: "Dashboard", icon: "dashboard" },
  { key: "bounties", name: "Bounties", icon: "moneybag" },
  { key: "wallet", name: "Wallet", icon: "coins" },
];

// ── Live notifications (bell state; the stream itself lives in LiveProvider) ──
function useNotifications(enabled: boolean) {
  const [items, setItems] = React.useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const refresh = React.useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await api.notifications();
      setItems(data.items);
      setUnreadCount(data.unreadCount);
    } catch (err: any) {
      if (err?.status !== 401) console.warn("[notifications] refresh failed:", err);
    }
  }, [enabled]);
  // The connection, the fallback poll and the tab-visible refresh all moved to
  // LiveProvider — one stream per tab, shared with the bounties and wallet
  // refetches. This hook only declares which topic the bell cares about.
  useLiveTopic("notifications", () => void refresh());
  React.useEffect(() => {
    if (!enabled) {
      setItems([]);
      setUnreadCount(0);
      return;
    }
    void refresh();
  }, [enabled, refresh]);
  const markAllRead = React.useCallback(async () => {
    const now = Date.now();
    setItems((prev) => prev.map((n) => (n.readAt === null ? { ...n, readAt: now } : n)));
    setUnreadCount(0);
    try {
      await api.markNotificationsRead();
    } catch {
      void refresh();
    }
  }, [refresh]);
  return { items, unreadCount, markAllRead };
}

const NotificationsPopover = ({
  items,
  unreadCount,
  onMarkAllRead,
  onNavigate,
  onClose,
}: {
  items: AppNotification[];
  unreadCount: number;
  onMarkAllRead: () => void;
  onNavigate: (link: string) => void;
  onClose: () => void;
}) => {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="card" style={{
      position: "absolute", top: 40, right: 0, width: 340, maxHeight: 420,
      overflowY: "auto", zIndex: 60, padding: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", padding: "4px 8px" }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-mute)" }}>notifications</span>
        <span style={{ flex: 1 }} />
        {unreadCount > 0 && (
          <button className="c-linkbtn" onClick={onMarkAllRead} style={{ fontSize: 11 }}>
            Mark all read
          </button>
        )}
      </div>
      {items.length === 0 && (
        <div className="mono mute" style={{ padding: 16, fontSize: 12 }}>Nothing yet.</div>
      )}
      {items.map((n) => (
        <div key={n.id}
          onClick={() => { if (n.link) onNavigate(n.link); onClose(); }}
          style={{
            display: "flex", gap: 10, padding: "8px", borderRadius: 6, cursor: n.link ? "pointer" : "default",
            opacity: n.readAt ? 0.55 : 1,
          }}>
          <i style={{
            width: 7, height: 7, borderRadius: "50%", marginTop: 5, flexShrink: 0,
            background: n.readAt ? "var(--line)" : "var(--accent)",
          }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "var(--fg)" }}>{n.title}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--fg-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.meta}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ── Sidebar ──────────────────────────────────────────────────────────────────
const Sidebar = ({ route, go }: { route: string; go: (key: string) => void }) => {
  const { bounties } = useBounties();
  const recent = bounties.slice(0, 3);
  return (
    <div className="sidebar">
      <div className="sb-head">
        <img src="/devasign-logo.svg" alt="DevAsign" className="sb-logo-img" />
      </div>

      <div className="sb-section">workspace</div>
      <div className="sb-list">
        {NAV.map((n) => (
          <div key={n.key} className={`sb-item ${route === n.key ? "active" : ""}`} onClick={() => go(n.key)}>
            <span className="icon"><Icon name={n.icon} size={15} /></span>
            <span className="sb-label">{n.name}</span>
          </div>
        ))}
        {FLAGS.disputes && (
          <div className={`sb-item ${route === "disputes" ? "active" : ""}`} onClick={() => go("disputes")}>
            <span className="icon"><Icon name="scale" size={15} /></span>
            <span className="sb-label">Disputes</span>
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <>
          <div className="sb-section">recent</div>
          <div className="sb-list">
            {recent.map((b) => (
              <div key={b.id} className="sb-item" onClick={() => go("bounties")}
                title={`${b.title} · ${STAGE_LABEL[bountyStage(b)]}`}>
                <span className="icon"><i style={{ width: 6, height: 6, background: "var(--accent)" }}></i></span>
                <span className="sb-label mono" style={{ fontSize: 12 }}>{b.repo}#{b.issueNumber}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ── User account popover (anchored under the topbar user button) ─────────────
const USER_MENU = [
  { id: "settings", label: "Settings", meta: "Account · Support", icon: "settings", kind: "nav" },
  { id: "signout", label: "Sign out", meta: "End session", icon: "logout", kind: "danger" },
] as const;

const UserPopover = ({
  onClose,
  onSignOut,
  onNavigate,
  user,
}: {
  onClose: () => void;
  onSignOut: () => void;
  onNavigate: () => void;
  user: User | null;
}) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    // Defer the outside-click listener a tick so the click that opened the
    // popover (on the toggle button, outside this ref) doesn't instantly close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const handle = (id: (typeof USER_MENU)[number]["id"]) => {
    if (id === "signout") onSignOut();
    if (id === "settings") onNavigate();
    onClose();
  };

  return (
    <div ref={ref} className="user-pop" role="menu" aria-label="Account">
      <div className="user-pop-head">
        <div className="user-pop-avatar">
          {user?.avatarUrl
            ? <img src={user.avatarUrl} alt="" style={{ width: "100%", height: "100%", borderRadius: "inherit", objectFit: "cover" }} />
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
        <span className="user-pop-org-role">contributor</span>
      </div>
      <div className="user-pop-list">
        {USER_MENU.map((item) => (
          <button
            key={item.id}
            role="menuitem"
            className={`user-row ${item.kind === "danger" ? "danger" : ""}`}
            onClick={() => handle(item.id)}
          >
            <span className="user-row-ico"><Icon name={item.icon} size={13} /></span>
            <span className="user-row-body">
              <span className="user-row-label">{item.label}</span>
              <span className="user-row-meta">{item.meta}</span>
            </span>
            <span className="user-row-chev">›</span>
          </button>
        ))}
      </div>
    </div>
  );
};

// ── Top bar ──────────────────────────────────────────────────────────────────
const TopBar = ({ route, isMobile }: { route: string; isMobile: boolean }) => {
  const auth = useAuth();
  const navigate = useNavigate();
  const notif = useNotifications(auth.status === "signed_in");
  const [notifOpen, setNotifOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);
  const labels: Record<string, string> = {
    dashboard: "Dashboard", bounties: "Bounties", wallet: "Wallet", disputes: "Disputes",
    settings: "Settings",
  };
  return (
    <div className="topbar">
      {isMobile && <img src="/devasign-logo.svg" alt="DevAsign" className="topbar-logo" />}
      <div className="crumbs">
        <span>@{auth.user?.githubLogin}</span>
        <span className="sep">/</span>
        <span className="now">{labels[route] ?? route}</span>
      </div>
      <div className="topbar-spacer"></div>
      <div className="topbar-actions">
        <div style={{ position: "relative" }}>
          <button className={`btn ghost sm ${notifOpen ? "is-active" : ""}`}
            style={{ position: "relative" }} aria-label="Notifications"
            onClick={() => setNotifOpen((v) => !v)}>
            <Icon name="bell" size={13} />
            {notif.unreadCount > 0 && (
              <i style={{ position: "absolute", top: 5, right: 6, width: 6, height: 6, background: "var(--accent)", borderRadius: "50%" }}></i>
            )}
          </button>
          {notifOpen && (
            <NotificationsPopover
              items={notif.items}
              unreadCount={notif.unreadCount}
              onMarkAllRead={notif.markAllRead}
              onNavigate={(link) => navigate(link)}
              onClose={() => setNotifOpen(false)}
            />
          )}
        </div>
        <div style={{ position: "relative" }}>
          <button className={`btn ghost sm ${userOpen ? "is-active" : ""}`}
            onClick={() => setUserOpen((v) => !v)}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Account menu" aria-haspopup="menu" aria-expanded={userOpen}>
            <Icon name="user" size={13} />
          </button>
          {userOpen && (
            <UserPopover
              onClose={() => setUserOpen(false)}
              onSignOut={() => void auth.signOut()}
              onNavigate={() => navigate("/settings")}
              user={auth.user}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// ── Mobile tab bar ───────────────────────────────────────────────────────────
const MobileTabs = ({ route, go }: { route: string; go: (key: string) => void }) => (
  <nav className="mtab-bar" role="navigation" aria-label="Primary">
    <div className="mtab-glass" aria-hidden="true"></div>
    <div className="mtab-row">
      {NAV.map((n) => (
        <button key={n.key} type="button" className={`mtab ${route === n.key ? "active" : ""}`}
          onClick={() => go(n.key)} aria-label={n.name}>
          <span className="mtab-icon"><Icon name={n.icon} size={19} /></span>
          <span className="mtab-label">{n.name}</span>
        </button>
      ))}
    </div>
  </nav>
);

// ── Signed-out / unavailable interstitials for app routes ────────────────────
const SignedOutScreen = () => {
  const auth = useAuth();
  const location = useLocation();
  return (
    <div className="c-authpage">
      <div className="c-authpage-inner">
        <img src="/devasign-logo.svg" alt="DevAsign" className="c-authpage-logo" />
        <h1 className="auth-h1" style={{ marginTop: 6 }}>
          Sign in to <span className="accent">continue</span>
        </h1>
        <p className="mute mono" style={{ fontSize: 12, lineHeight: 1.6, margin: "10px 0 18px" }}>
          Your bounties, submissions, and payout wallet live behind your GitHub identity.
        </p>
        <button className="gh-btn" onClick={() => auth.signIn(location.pathname)}>
          <Icon name="github" size={18} /> Continue with GitHub
        </button>
      </div>
    </div>
  );
};

const UnavailableScreen = () => {
  const auth = useAuth();
  return (
    <div className="c-authpage">
      <div className="c-authpage-inner">
        <img src="/devasign-logo.svg" alt="DevAsign" className="c-authpage-logo" />
        <h1 className="auth-h1" style={{ marginTop: 6 }}>Account temporarily unavailable</h1>
        <p className="mute mono" style={{ fontSize: 12, lineHeight: 1.6, margin: "10px 0 18px" }}>
          You're signed in, but the backend couldn't load your account just now. Retrying usually fixes it.
        </p>
        <button className="btn primary" onClick={() => void auth.reload()}>Try again</button>
      </div>
    </div>
  );
};

const LoadingScreen = () => (
  <div style={{ display: "grid", placeItems: "center", height: "calc(100vh / var(--zoom))" }}>
    <span className="mono mute" style={{ fontSize: 12 }}>loading…</span>
  </div>
);

// ── The in-app shell (sidebar + topbar + content) ────────────────────────────
function Shell({ route, children }: { route: string; children: React.ReactNode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  if (auth.status === "loading") return <LoadingScreen />;
  if (auth.status === "unavailable") return <UnavailableScreen />;
  if (auth.status === "signed_out") return <SignedOutScreen />;
  const go = (key: string) => navigate(`/${key}`);
  return (
    <div className={`app density-regular ${isMobile ? "is-mobile" : ""}`}>
      {!isMobile && <Sidebar route={route} go={go} />}
      <div className="main">
        <TopBar route={route} isMobile={isMobile} />
        <div className="content" style={route === "bounties" ? { overflow: "hidden", display: "flex", flexDirection: "column" } : {}}>
          {children}
        </div>
      </div>
      {isMobile && <MobileTabs route={route} go={go} />}
    </div>
  );
}

// Lazy so the flag-off build never even loads the dispute code path.
const DisputePage = React.lazy(() =>
  import("./dispute").then((m) => ({ default: m.DisputePage }))
);

function DiscoveryRoute() {
  const { id } = useParams();
  return <Discovery bountyId={id!} />;
}

export default function App() {
  // LiveProvider wraps BountiesProvider (which subscribes to it) and sits above
  // <Routes> so navigating never tears down and re-opens the SSE connection.
  return (
    <BountiesProvider>
      <Routes>
        <Route path="/bounties/:id" element={<DiscoveryRoute />} />
        <Route path="/auth" element={<AuthGate />} />
        <Route path="/dashboard" element={<Shell route="dashboard"><Dashboard /></Shell>} />
        <Route path="/bounties" element={<Shell route="bounties"><BountiesPage /></Shell>} />
        <Route path="/wallet" element={<Shell route="wallet"><WalletPage /></Shell>} />
        <Route path="/settings" element={<Navigate to="/settings/account" replace />} />
        <Route path="/settings/:section" element={<Shell route="settings"><SettingsPage /></Shell>} />
        {FLAGS.disputes && (
          <Route path="/disputes" element={
            <Shell route="disputes">
              <React.Suspense fallback={<LoadingScreen />}>
                <DisputePage />
              </React.Suspense>
            </Shell>
          } />
        )}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <Analytics />
    </BountiesProvider>
  );
}
