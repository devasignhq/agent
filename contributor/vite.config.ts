import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Vite INLINES VITE_* vars into the bundle, so a missing or malformed
// VITE_API_BASE cannot be corrected after the fact — it ships, and then presents
// as a broken login instead of as a config error. src/api.ts deliberately keeps
// no fallback API origin (a hardcoded one silently pins every future build to
// one host), so the value is mandatory and checked here, at the only point where
// the failure is still cheap and the message actually gets read.
//
// Guarded to production builds only: `vite dev` legitimately runs with it unset
// (talk to localhost:8787 directly) or empty (relative URLs → the proxy below).
function assertApiBase(mode: string): void {
  const apiBase = (loadEnv(mode, process.cwd(), 'VITE_').VITE_API_BASE ?? '').trim();
  // Origin only — a path or query would corrupt every `${API_BASE}/api/…` join.
  // A single trailing slash is tolerated because api.ts strips it.
  if (/^https?:\/\/[^/\s]+\/?$/.test(apiBase)) return;
  throw new Error(
    `VITE_API_BASE must be an absolute API origin, e.g. https://devasign-agent.onrender.com\n` +
      `  received: ${apiBase === '' ? '(unset or empty)' : apiBase}\n` +
      `Set it in this project's environment variables — on Vercel that is\n` +
      `Settings → Environment Variables, scoped to Production — then redeploy.`,
  );
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && mode === 'production') assertApiBase(mode);
  return {
    plugins: [react()],
    server: {
      port: 3002,
      proxy: {
        '/api': 'http://localhost:8787',
      },
    },
  };
});
