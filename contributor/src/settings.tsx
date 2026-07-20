// Settings page (and its sub-sections): Account (profile + delete) and Support.
// Ported from the maintainer app's settings screen, trimmed to the sections a
// contributor account actually has.
import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Icon } from "./icons";
import { api } from "./api";
import { useAuth } from "./auth-context";
import { DELETE_PHRASE, deleteConfirmOk } from "./model.ts";

const SET_SECTIONS = [
  { key: "account", name: "Account" },
  { key: "support", name: "Support" },
];

export const SettingsPage = () => {
  // The active sub-section comes from the URL (/settings/:section), so tabs are
  // linkable and back/forward moves between them. Unknown/missing → account.
  const { section } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const sec = SET_SECTIONS.some((s) => s.key === section) ? section : "account";
  return (
    <div className="page" style={{ maxWidth: "none" }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-sub">@{auth.user?.githubLogin}</div>
        </div>
      </div>

      <div className="set-grid">
        <div className="set-nav">
          {SET_SECTIONS.map((s) => (
            <div key={s.key}
              className={`set-nav-item ${sec === s.key ? "active" : ""}`}
              onClick={() => navigate("/settings/" + s.key)}>{s.name}</div>
          ))}
        </div>

        <div>
          {sec === "support" && <SetSupport />}
          {sec === "account" && <SetAccount />}
        </div>
      </div>
    </div>
  );
};

// ─── Account · profile + delete ─────────────────────────────────────────────
// Deletion is immediate and permanent: the account and all its data are wiped
// the moment the user confirms — no restore window. These stay as friendly
// fallbacks for the rare error shapes the request can still surface.
const DELETE_ERRORS: Record<string, string> = {
  billing_cancel_failed: "Something went wrong. Please try again.",
  github_uninstall_failed: "Something went wrong. Please try again.",
};

const SetAccount = () => {
  const { user, signOut } = useAuth();
  const [step, setStep] = React.useState<"idle" | "confirm" | "done">("idle");
  const [confirmText, setConfirmText] = React.useState("");
  const [confirmName, setConfirmName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const confirmOk = deleteConfirmOk(user?.githubLogin, confirmName, confirmText);

  // Delete the account server-side (immediate, permanent), then advance to the
  // done step. On failure nothing changes (retry-safe), so we surface the error
  // and stay on the confirm step instead of pretending it worked.
  const deleteAccount = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.deleteAccount();
      setStep("done");
    } catch (e: any) {
      setErr(DELETE_ERRORS[e?.message] || e?.message || "Couldn't delete your account. Please try again.");
      setBusy(false);
    }
  };

  // Once the account is gone, end the session and bounce to the sign-in screen
  // (the cookie is already cleared server-side; this flips client auth state).
  React.useEffect(() => {
    if (step !== "done") return;
    const t = setTimeout(() => { void signOut(); }, 2000);
    return () => clearTimeout(t);
  }, [step, signOut]);

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
          <span className="pill danger"><i className="dot"></i> permanent</span>
        </div>
        <div className="card-body">
          {step === "idle" && (
            <div className="flex justify-between items-center" style={{ gap: 16, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="mono" style={{ fontSize: 13 }}>Delete your account</div>
                <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
                  This is immediate and permanent. Your profile, applications, submissions, and payout
                  wallet are erased right away — there's no way to undo it or restore later.
                </div>
              </div>
              <button className="btn danger" onClick={() => setStep("confirm")}>Delete account…</button>
            </div>
          )}

          {step === "confirm" && (
            <div className="col gap-3">
              <div className="mono" style={{ fontSize: 13, color: "var(--danger)" }}>This can't be undone.</div>
              <div className="mute" style={{ fontSize: 12 }}>
                Your account and all its data are deleted immediately and permanently — there's no grace
                period and no way to restore it afterward.
              </div>
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
                Then type <span className="mono" style={{ color: "var(--fg)" }}>"{DELETE_PHRASE}"</span> to confirm.
              </div>
              <input
                className="input"
                placeholder={DELETE_PHRASE}
                value={confirmText}
                autoComplete="off"
                onChange={(e) => setConfirmText(e.target.value)}
                style={{ maxWidth: 360, fontFamily: "var(--mono)" }} />
              <div className="flex gap-2">
                <button className="btn" disabled={busy}
                  onClick={() => { setStep("idle"); setConfirmText(""); setConfirmName(""); setErr(null); }}>Cancel</button>
                <button
                  className="btn danger"
                  disabled={!confirmOk || busy}
                  onClick={() => void deleteAccount()}>
                  {busy ? "Deleting…" : "Delete my account"}
                </button>
              </div>
              {err && <div className="mute" style={{ color: "var(--danger)", fontSize: 12 }}>{err}</div>}
            </div>
          )}

          {step === "done" && (
            <div className="col gap-2">
              <div className="flex items-center gap-2">
                <Icon name="check" size={14} color="var(--accent)" />
                <span className="mono" style={{ fontSize: 13 }}>Account deleted</span>
              </div>
              <div className="mute" style={{ fontSize: 12 }}>
                Your account and all its data have been permanently deleted. Signing you out…
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Support ────────────────────────────────────────────────────────────────
const SUPPORT_CHANNELS: Array<{ name: string; desc: React.ReactNode; cta?: string; href?: string; i: string }> = [
  { name: "Documentation", desc: "Full docs · API reference · self-serve guides", cta: "devasign.com/docs", href: "https://devasign.com/docs", i: "doc" },
  { name: "Discord community", desc: "Join the community · #help channel", cta: "Join Discord", href: "https://discord.com/invite/GtvqA4UPwT", i: "discord" },
  {
    name: "Email support", i: "send",
    desc: <>Send us an email at <a className="mono" style={{ color: "var(--accent)", textDecoration: "none" }} href="mailto:support@devasign.com">support@devasign.com</a> and we'll reply within an hour.</>,
  },
];

const SetSupport = () => (
  <div className="col gap-5">
    <div className="card">
      <div className="card-head"><h3 className="card-title">Support channels</h3></div>
      <div>
        {SUPPORT_CHANNELS.map((s) => (
          <div key={s.name} className="row" style={{ display: "grid", gridTemplateColumns: "40px 1fr auto", gap: 14, height: 64 }}>
            <div className="integ-icon"><Icon name={s.i} size={14} /></div>
            <div>
              <div className="mono" style={{ fontSize: 13 }}>{s.name}</div>
              <div className="mute" style={{ fontSize: 12, marginTop: 2 }}>{s.desc}</div>
            </div>
            {s.href && (
              <a className="btn" href={s.href} target="_blank" rel="noopener noreferrer">{s.cta} <Icon name="external" size={11} /></a>
            )}
          </div>
        ))}
      </div>
    </div>
  </div>
);
