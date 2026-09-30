import type { Db } from "./schema.js";

export type BillingEvent = { id?: string; kind?: string; tenantId?: string; amountCents?: number };

export function creditsFor(db: Db, tenantId: string): number {
  const row = db.prepare("select credits_cents as credits from tenants where id = ?").get(tenantId) as
    | { credits: number }
    | undefined;
  return row?.credits ?? 0;
}

export function applyBillingEvent(db: Db, event: BillingEvent, receivedAt: string): boolean {
  const tenantId = String(event.tenantId ?? "");
  const amount = Math.trunc(Number(event.amountCents ?? 0));
  if (!tenantId || !Number.isFinite(amount)) return false;
  db.prepare("update tenants set credits_cents = credits_cents + ? where id = ?").run(amount, tenantId);
  db.prepare("insert or replace into webhook_events (id, kind, received_at) values (?, ?, ?)").run(
    String(event.id ?? `evt-${receivedAt}`),
    String(event.kind ?? "unknown"),
    receivedAt
  );
  return true;
}
