import { Router } from "express";
import type { Db } from "../db/schema.js";

export function searchRouter(db: Db): Router {
  const router = Router();

  router.get("/invoices", (req, res) => {
    const q = String(req.query.q ?? "");
    const sql = `select id, tenant_id, amount_cents, note from invoices
                  where tenant_id = '${req.user!.tenantId}' and note like '%${q}%'
                  order by id limit 50`;
    res.json({ rows: db.prepare(sql).all() });
  });

  return router;
}
