import type { Db } from "./schema.js";

export type Invoice = { id: string; tenant_id: string; amount_cents: number; note: string };

export function findInvoice(db: Db, invoiceId: string): Invoice | null {
  const row = db.prepare("select id, tenant_id, amount_cents, note from invoices where id = ?").get(invoiceId);
  return (row as Invoice | undefined) ?? null;
}

export function findInvoiceForTenant(db: Db, invoiceId: string, tenantId: string): Invoice | null {
  const row = db
    .prepare("select id, tenant_id, amount_cents, note from invoices where id = ? and tenant_id = ?")
    .get(invoiceId, tenantId);
  return (row as Invoice | undefined) ?? null;
}

export function listInvoicesForTenant(db: Db, tenantId: string, limit: number, offset: number): Invoice[] {
  return db
    .prepare("select id, tenant_id, amount_cents, note from invoices where tenant_id = ? order by id limit ? offset ?")
    .all(tenantId, limit, offset) as Invoice[];
}
