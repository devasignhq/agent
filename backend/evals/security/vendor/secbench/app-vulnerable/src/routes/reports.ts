import { Router } from "express";

export type ReportDeps = {
  fetchImpl: typeof fetch;
  lookup: (hostname: string) => Promise<string>;
  allowedHosts: string[];
  timeoutMs: number;
};

export function reportsRouter(deps: ReportDeps): Router {
  const router = Router();

  router.post("/fetch", async (req, res) => {
    const url = String(req.body?.url ?? "");
    if (!url) return void res.status(400).json({ error: "url_required" });
    try {
      const upstream = await deps.fetchImpl(url, { signal: AbortSignal.timeout(deps.timeoutMs) });
      res.json({ status: upstream.status, body: (await upstream.text()).slice(0, 2000) });
    } catch {
      res.status(502).json({ error: "upstream_failed" });
    }
  });

  return router;
}
