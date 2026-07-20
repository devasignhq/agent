import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import App from "./app";
import { AuthProvider } from "./auth-context";
import "./styles.css";

(window as any).__resources = { logo: "/devasign-logo.svg" };

// Popup-completion shortcut. The auth + GitHub-App-install + Linear-connect
// flows all open in a popup; when the provider finishes and redirects the
// popup back to our origin with `?installation_id=N&setup_action=install`
// (install), `?auth=ok` (GitHub oauth post-redirect), or
// `?linear=connected|error` (Linear connect outcome), we postMessage the
// opener and self-close so the user never leaves their original tab. The
// Linear *error* case is handled here too — otherwise the full SPA would mount
// inside the popup instead of closing.
const popupCompletion = (function popupHandshake() {
  try {
    const url = new URL(window.location.href);
    const installationId = url.searchParams.get("installation_id");
    const authOk = url.searchParams.get("auth") === "ok";
    const linearParam = url.searchParams.get("linear");
    const linearConnected = linearParam === "connected";
    const linearError = linearParam === "error";
    if (!installationId && !authOk && !linearConnected && !linearError) return null;
    if (!window.opener || window.opener.closed) return null;
    const msg = installationId
      ? { type: "devasign_install_done", installationId: Number(installationId) }
      : linearConnected
      ? { type: "devasign_linear_done", ok: true }
      : linearError
      ? { type: "devasign_linear_done", ok: false }
      : { type: "devasign_auth_done" };
    window.opener.postMessage(msg, window.location.origin);
    // Best-effort self-close. After cross-origin navigation through GitHub,
    // most browsers refuse this — that's why the opener also calls
    // popup.close() via popup-registry on message receipt.
    try { window.close(); } catch {}
    const label = installationId
      ? "Install complete."
      : linearConnected
      ? "Linear connected."
      : linearError
      ? "Couldn't connect Linear."
      : "Signed in.";
    document.body.innerHTML =
      '<div style="font-family:ui-monospace,monospace;color:#888;display:grid;place-items:center;height:100vh;text-align:center">' +
      `<div>${label}<br/>Closing…</div></div>`;
    return msg.type;
  } catch {
    return null;
  }
})();

// If we just handed off to the opener, don't bother mounting the full app —
// the popup will close itself shortly; rendering React would only flash UI.
if (!popupCompletion) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
      <Analytics />
    </React.StrictMode>
  );
}
