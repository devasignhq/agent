import { Router } from "express";
import type { Db } from "../db/schema.js";
import { applyBillingEvent } from "../db/billing.js";
import { nowIso } from "../lib/time.js";
import { requireWebhookSignature } from "../middleware/webhook-signature.js";

export function partnersRouter(db: Db, secret: string): Router {
  const router = Router();

  router.post("/sync", requireWebhookSignature(secret), (req, res) => {
    const applied = applyBillingEvent(db, req.body ?? {}, nowIso());
    res.json({ ok: applied });
  });

  return router;
}
