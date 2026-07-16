// Build-time feature flags. Vite inlines VITE_-prefixed env vars at build
// time, so flipping one is a Vercel env change + redeploy — no runtime config.
export const FLAGS = {
  // Dispute-resolution screens: pure UI preview with no backend — local demo
  // state only, clearly ribboned. Off by default everywhere.
  disputes: (import.meta as any).env?.VITE_FEATURE_DISPUTES === "1",
};
