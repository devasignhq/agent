import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app";
import { AuthProvider } from "./auth-context";
import "./styles.css";

(window as any).__resources = { logo: "/devasign-logo.svg" };

// Popup-completion shortcut. The auth + GitHub-App-install flows both open in
// a popup; when GitHub finishes and redirects the popup back to our origin
// with either `?installation_id=N&setup_action=install` (install) or
// `?auth=ok` (oauth callback's post-redirect), we postMessage the opener and
// self-close so the user never leaves their original tab.
const popupCompletion = (function popupHandshake() {
  try {
    const url = new URL(window.location.href);
    const installationId = url.searchParams.get("installation_id");
    const authOk = url.searchParams.get("auth") === "ok";
    if (!installationId && !authOk) return null;
    if (!window.opener || window.opener.closed) return null;
    const msg = installationId
      ? { type: "devasign_install_done", installationId: Number(installationId) }
      : { type: "devasign_auth_done" };
    window.opener.postMessage(msg, window.location.origin);
    // Best-effort self-close. After cross-origin navigation through GitHub,
    // most browsers refuse this — that's why the opener also calls
    // popup.close() via popup-registry on message receipt.
    try { window.close(); } catch {}
    const label = installationId ? "Install complete." : "Signed in.";
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
      <AuthProvider>
        <App />
      </AuthProvider>
    </React.StrictMode>
  );
}
