import { Router } from "express";
import type { Db } from "../db/schema.js";
import { applyBillingEvent } from "../db/billing.js";
import { nowIso } from "../lib/time.js";

export function webhooksRouter(db: Db, _secret: string): Router {
  const router = Router();

  router.post("/billing", (req, res) => {
    const applied = applyBillingEvent(db, req.body ?? {}, nowIso());
    if (!applied) return void res.status(400).json({ error: "invalid_event" });
    res.json({ ok: true });
  });

  return router;
}
