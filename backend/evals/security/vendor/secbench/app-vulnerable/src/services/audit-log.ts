import type { Db } from "../db/schema.js";
import { nowIso } from "../lib/time.js";

export function record(db: Db, actor: string, action: string): void {
  db.prepare("insert into audit_log (actor, action, at) values (?, ?, ?)").run(actor, action, nowIso());
}

export function entriesFor(db: Db, actor: string): Array<{ action: string; at: string }> {
  return db.prepare("select action, at from audit_log where actor = ? order by id").all(actor) as Array<{
    action: string;
    at: string;
  }>;
}
