import { Router } from "express";
import type { Db } from "../db/schema.js";
import { listTenants, setTenantActive } from "../db/users.js";
import { record } from "../services/audit-log.js";

export function adminRouter(db: Db): Router {
  const router = Router();

  router.get("/tenants", (_req, res) => {
    res.json({ tenants: listTenants(db) });
  });

  router.post("/tenants/:tenantId/disable", (req, res) => {
    setTenantActive(db, String(req.params.tenantId), false);
    record(db, req.user?.email ?? "unknown", `disable ${req.params.tenantId}`);
    res.json({ ok: true });
  });

  return router;
}
