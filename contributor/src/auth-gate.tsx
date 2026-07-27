// GitHub authenticate gate — where "Proceed to Apply" lands a signed-out
// developer. Ported from the design's CAuth; "Continue with GitHub" does a
// top-level redirect (a cold landing has no app state worth preserving in a
// popup) whose returnTo brings them straight back to the bounty with the
// apply modal auto-opened.
import React from "react";
import { useNavigate, useSearchParams, Navigate } from "react-router-dom";
import { useAuth } from "./auth-context";
import { Icon } from "./icons";

export function AuthGate() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const bountyId = params.get("bounty");
  const [connecting, setConnecting] = React.useState(false);

  // Already has a contributor session — skip the gate. (A maintainer session on
  // the sponsor dashboard does NOT count: this app has its own account/cookie, so
  // a maintainer who lands here signs in as a contributor through this gate.)
  if (auth.status === "signed_in") {
    return <Navigate to={bountyId ? `/bounties/${bountyId}?apply=1` : "/dashboard"} replace />;
  }

  const go = () => {
    if (connecting) return;
    setConnecting(true);
    auth.signIn(bountyId ? `/bounties/${bountyId}?apply=1` : "/dashboard");
  };

  return (
    <div className="c-authpage">
      <div className="c-authpage-bg" aria-hidden="true">
        <span className="c-neon a"></span>
        <span className="c-neon b"></span>
        <span className="c-neon c"></span>
      </div>

      <div className="c-authpage-inner">
        <div className="c-auth-back" onClick={() => (bountyId ? navigate(`/bounties/${bountyId}`) : navigate(-1))} style={{ marginBottom: 18 }}>
          <Icon name="chevron-r" size={12} style={{ transform: "rotate(180deg)" }} /> Go Back
        </div>

        <img src="/devasign-logo.svg" alt="DevAsign" className="c-authpage-logo" />

        <h1 className="auth-h1" style={{ marginTop: 6 }}>Sign up to <span className="accent">apply</span></h1>

        <div className="c-auth-scopes">
          <div className="c-auth-scope"><Icon name="check" size={12} /><span><b>Read your public profile</b> — name, avatar, and repositories the maintainer can already see.</span></div>
          <div className="c-auth-scope"><Icon name="check" size={12} /><span>Scopes requested: <code>read:user</code>, <code>user:email</code>. We never write to your code.</span></div>
          <div className="c-auth-scope"><Icon name="check" size={12} /><span>You'll confirm your <b>USDC payout wallet</b> as you apply — and can change it any time.</span></div>
        </div>

        <button className="gh-btn" onClick={go} disabled={connecting}>
          {connecting
            ? <><span className="dot pulse" style={{ width: 8, height: 8, background: "#0a0b0d" }}></span> Redirecting to GitHub…</>
            : <><Icon name="github" size={18} /> Continue with GitHub</>}
        </button>
        <p className="mute mono" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.6 }}>
          By continuing you agree to the Terms and Privacy.
        </p>
      </div>
    </div>
  );
}
