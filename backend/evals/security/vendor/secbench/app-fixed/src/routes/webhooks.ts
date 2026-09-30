import { Router } from "express";
import type { Db } from "../db/schema.js";
import { applyBillingEvent } from "../db/billing.js";
import { nowIso } from "../lib/time.js";
import { requireWebhookSignature } from "../middleware/webhook-signature.js";

export function webhooksRouter(db: Db, secret: string): Router {
  const router = Router();

  router.post("/billing", requireWebhookSignature(secret), (req, res) => {
    const applied = applyBillingEvent(db, req.body ?? {}, nowIso());
    if (!applied) return void res.status(400).json({ error: "invalid_event" });
    res.json({ ok: true });
  });

  return router;
}
