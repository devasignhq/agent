import type { Db } from "./schema.js";

export type SessionUser = { id: string; tenantId: string; email: string; role: string };

export function userForToken(db: Db, token: string): SessionUser | null {
  const row = db
    .prepare(
      `select users.id as id, users.tenant_id as tenantId, users.email as email, users.role as role
         from sessions join users on users.id = sessions.user_id
        where sessions.token = ?`
    )
    .get(token) as SessionUser | undefined;
  return row ?? null;
}

export function listTenants(db: Db): Array<{ id: string; name: string; active: number }> {
  return db.prepare("select id, name, active from tenants order by id").all() as Array<{
    id: string;
    name: string;
    active: number;
  }>;
}

export function setTenantActive(db: Db, tenantId: string, active: boolean): void {
  db.prepare("update tenants set active = ? where id = ?").run(active ? 1 : 0, tenantId);
}
