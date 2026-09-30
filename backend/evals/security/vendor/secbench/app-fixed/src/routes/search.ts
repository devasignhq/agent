import { Router } from "express";
import type { Db } from "../db/schema.js";

export function searchRouter(db: Db): Router {
  const router = Router();

  router.get("/invoices", (req, res) => {
    const q = String(req.query.q ?? "");
    const rows = db
      .prepare(
        `select id, tenant_id, amount_cents, note from invoices
          where tenant_id = ? and note like ?
          order by id limit 50`
      )
      .all(req.user!.tenantId, `%${q}%`);
    res.json({ rows });
  });

  return router;
}
