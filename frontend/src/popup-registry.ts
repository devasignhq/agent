// Module-level holders for the auth + install popup `Window` references so
// the opener-side message listener (in app.tsx) can call `popup.close()` on
// receipt of devasign_install_done / devasign_auth_done.
//
// Why: after navigating through GitHub and back, the popup's own
// `window.close()` is blocked by Chromium/Safari (history.length > 1). The
// opener calling `popup.close()` is always allowed because the opener holds
// the Window reference from `window.open()`.

export type PopupKind = "install" | "auth" | "linear";

const popups: Record<PopupKind, Window | null> = {
  install: null,
  auth: null,
  linear: null,
};

export function registerPopup(kind: PopupKind, win: Window | null) {
  popups[kind] = win;
}

export function closePopup(kind: PopupKind) {
  const win = popups[kind];
  if (!win) return;
  try {
    if (!win.closed) win.close();
  } catch {
    // Cross-origin or already-closed — ignore.
  }
  popups[kind] = null;
}
