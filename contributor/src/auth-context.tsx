// Session context. Loads /api/me once on mount, exposes user, reload(), and
// signOut(). This app has its OWN session cookie (devasign_session_contributor,
// set on api.devasign.ai): the same GitHub identity has a separate contributor
// account here and maintainer account on the sponsor dashboard, so signing into
// one app does NOT sign into the other — each resolves its own account by Origin.
import React from "react";
import { api, oauthStartUrl } from "./api";
import type { Subscription, User } from "./api";

type AuthState =
  | { status: "loading"; user: null }
  | { status: "signed_out"; user: null }
  // Valid session, but the backend can't resolve the account right now (503
  // account_unavailable) — almost always a store that lost data on a redeploy.
  // Distinct from signed_out so the UI shows an honest "try again" instead of
  // the sign-in screen, which would let the user mint a fresh, orphaned account.
  | { status: "unavailable"; user: null }
  | { status: "signed_in"; user: User };

type AuthCtx = AuthState & {
  reload: () => Promise<void>;
  signIn: (returnTo?: string) => void;
  signOut: () => Promise<void>;
};

const Ctx = React.createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AuthState>({ status: "loading", user: null });

  const reload = React.useCallback(async () => {
    try {
      const me = await api.me();
      setState({ status: "signed_in", user: me.user });
    } catch (err: any) {
      if (err?.status === 503 && (err?.body as any)?.error === "account_unavailable") {
        setState({ status: "unavailable", user: null });
        return;
      }
      if (err?.status !== 401) console.error("[auth] /me failed", err);
      setState({ status: "signed_out", user: null });
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const signIn = React.useCallback((returnTo?: string) => {
    // Belt-and-braces: also stash the return path locally in case the redirect
    // chain loses the query (mirrors the sponsor app's devasign_return_to).
    if (returnTo) {
      try { localStorage.setItem("devasign_return_to", returnTo); } catch {}
    }
    window.location.href = oauthStartUrl(returnTo ?? window.location.pathname);
  }, []);

  const signOut = React.useCallback(async () => {
    try {
      await api.signOut();
    } catch {
      // ignore — sign out is best-effort
    }
    setState({ status: "signed_out", user: null });
  }, []);

  const value: AuthCtx = { ...state, reload, signIn, signOut } as AuthCtx;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}

export type { Subscription, User };
