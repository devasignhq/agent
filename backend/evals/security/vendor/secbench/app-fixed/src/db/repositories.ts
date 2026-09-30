import type { Db } from "./schema.js";

export type Order = { id: string; tenant_id: string; sku: string; quantity: number };

// Every accessor here is bound to the tenant the repository was built for, so a
// caller cannot widen the scope by passing a different id.
export function repositoriesFor(db: Db, tenantId: string) {
  return {
    orders: {
      get(orderId: string): Order | null {
        const row = db
          .prepare("select id, tenant_id, sku, quantity from orders where id = ? and tenant_id = ?")
          .get(orderId, tenantId);
        return (row as Order | undefined) ?? null;
      },
      list(limit: number): Order[] {
        return db
          .prepare("select id, tenant_id, sku, quantity from orders where tenant_id = ? order by id limit ?")
          .all(tenantId, limit) as Order[];
      },
    },
  };
}

export type Repositories = ReturnType<typeof repositoriesFor>;
