import { Router } from "express";
import type { Db } from "../db/schema.js";
import { findInvoiceForTenant, listInvoicesForTenant } from "../db/invoices.js";
import { formatCents } from "../lib/money.js";
import { parsePage } from "../lib/pagination.js";
import type { Notifier } from "../services/notify.js";

export function invoicesRouter(db: Db, notifier: Notifier, maxPageSize: number): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const page = parsePage(req.query as Record<string, unknown>, maxPageSize);
    const rows = listInvoicesForTenant(db, req.user!.tenantId, page.limit, page.offset);
    res.json({ invoices: rows.map((r) => ({ ...r, amount: formatCents(r.amount_cents) })) });
  });

  router.get("/:invoiceId", (req, res) => {
    const invoice = findInvoiceForTenant(db, String(req.params.invoiceId), req.user!.tenantId);
    if (!invoice) return void res.status(404).json({ error: "not_found" });
    notifier.invoiceViewed(req.user!.tenantId, invoice.id);
    res.json({ invoice: { ...invoice, amount: formatCents(invoice.amount_cents) } });
  });

  return router;
}
