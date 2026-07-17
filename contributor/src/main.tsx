import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./app";
import { AuthProvider } from "./auth-context";
import "./styles.css";

(window as any).__resources = { logo: "/devasign-logo.svg", stellarIcon: "/stellar-icon.png" };

// Popup-completion shortcut, trimmed to the one flow this app has (GitHub
// OAuth). When sign-in ran in a popup and the callback redirected back with
// `?auth=ok`, postMessage the opener and self-close instead of mounting the
// SPA inside the popup. Top-level (non-popup) navigation has no opener, so the
// app mounts normally and the discovery page handles ?auth=ok itself.
const popupCompletion = (function popupHandshake() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("auth") !== "ok") return null;
    if (!window.opener || (window.opener as Window).closed) return null;
    (window.opener as Window).postMessage({ type: "devasign_auth_done" }, window.location.origin);
    try { window.close(); } catch {}
    document.body.innerHTML =
      '<div style="font-family:ui-monospace,monospace;color:#888;display:grid;place-items:center;height:100vh;text-align:center">' +
      "<div>Signed in.<br/>Closing…</div></div>";
    return "devasign_auth_done";
  } catch {
    return null;
  }
})();

if (!popupCompletion) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </React.StrictMode>
  );
}
