// Session context. Loads /api/me once on mount, exposes user + subscription,
// reload(), and signOut(). Drives top-level routing in app.tsx (auth →
// onboarding → app).
import React from "react";
import { api, oauthStartUrl } from "./api";
import type { Subscription, User } from "./api";

type AuthState =
  | { status: "loading"; user: null; subscription: null }
  | { status: "signed_out"; user: null; subscription: null }
  // Valid session, but the backend can't resolve the account right now (503
  // account_unavailable) — almost always a store that lost data on a redeploy.
  // Distinct from signed_out so the UI shows an honest "try again" instead of the
  // sign-in screen, which would let the user mint a fresh, orphaned account.
  | { status: "unavailable"; user: null; subscription: null }
  | { status: "signed_in"; user: User; subscription: Subscription | null };

type AuthCtx = AuthState & {
  reload: () => Promise<void>;
  signIn: () => void;
  signOut: () => Promise<void>;
};

const Ctx = React.createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AuthState>({
    status: "loading",
    user: null,
    subscription: null,
  });

  const reload = React.useCallback(async () => {
    try {
      const me = await api.me();
      setState({
        status: "signed_in",
        user: me.user,
        subscription: me.subscription,
      });
    } catch (err: any) {
      // A validly-signed session the backend couldn't resolve (503
      // account_unavailable): the session exists but the account is unreachable
      // right now — almost always a store wiped on a redeploy. Do NOT collapse
      // this into signed_out: that shows the sign-in screen and lets the user mint
      // a fresh account, orphaning the real one. Surface a retryable state.
      if (err?.status === 503 && (err?.body as any)?.error === "account_unavailable") {
        setState({ status: "unavailable", user: null, subscription: null });
        return;
      }
      if (err?.status === 401) {
        setState({ status: "signed_out", user: null, subscription: null });
      } else {
        console.error("[auth] /me failed", err);
        setState({ status: "signed_out", user: null, subscription: null });
      }
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const signIn = React.useCallback(() => {
    window.location.href = oauthStartUrl;
  }, []);

  const signOut = React.useCallback(async () => {
    try {
      await api.signOut();
    } catch {
      // ignore — sign out is best-effort
    }
    setState({ status: "signed_out", user: null, subscription: null });
  }, []);

  const value: AuthCtx = { ...state, reload, signIn, signOut };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}
