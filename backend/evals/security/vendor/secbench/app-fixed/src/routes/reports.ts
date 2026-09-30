import { Router } from "express";
import net from "node:net";

export type ReportDeps = {
  fetchImpl: typeof fetch;
  lookup: (hostname: string) => Promise<string>;
  allowedHosts: string[];
  timeoutMs: number;
};

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const lower = address.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

export function reportsRouter(deps: ReportDeps): Router {
  const router = Router();

  router.post("/fetch", async (req, res) => {
    const raw = String(req.body?.url ?? "");
    if (!raw) return void res.status(400).json({ error: "url_required" });

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return void res.status(400).json({ error: "invalid_url" });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return void res.status(400).json({ error: "unsupported_scheme" });
    }
    if (!deps.allowedHosts.includes(parsed.hostname)) {
      return void res.status(400).json({ error: "host_not_allowed" });
    }
    const address = net.isIP(parsed.hostname) ? parsed.hostname : await deps.lookup(parsed.hostname);
    if (isPrivateAddress(address)) {
      return void res.status(400).json({ error: "host_not_allowed" });
    }

    try {
      const upstream = await deps.fetchImpl(raw, { signal: AbortSignal.timeout(deps.timeoutMs) });
      res.json({ status: upstream.status, body: (await upstream.text()).slice(0, 2000) });
    } catch {
      res.status(502).json({ error: "upstream_failed" });
    }
  });

  return router;
}
