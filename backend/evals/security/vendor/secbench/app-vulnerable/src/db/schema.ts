import type { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function migrate(db: Db): void {
  db.exec(`
    create table tenants (id text primary key, name text not null, credits_cents integer not null default 0, active integer not null default 1);
    create table users (id text primary key, tenant_id text not null, email text not null, role text not null);
    create table sessions (token text primary key, user_id text not null);
    create table invoices (id text primary key, tenant_id text not null, amount_cents integer not null, note text not null);
    create table orders (id text primary key, tenant_id text not null, sku text not null, quantity integer not null);
    create table webhook_events (id text primary key, kind text not null, received_at text not null);
    create table audit_log (id integer primary key autoincrement, actor text not null, action text not null, at text not null);
  `);
}

export function seed(db: Db): void {
  const tenant = db.prepare("insert into tenants (id, name, credits_cents) values (?, ?, ?)");
  tenant.run("acme", "Acme Industries", 5_000);
  tenant.run("globex", "Globex Corporation", 7_500);

  const user = db.prepare("insert into users (id, tenant_id, email, role) values (?, ?, ?, ?)");
  user.run("u-acme-member", "acme", "member@acme.test", "member");
  user.run("u-acme-admin", "acme", "admin@acme.test", "admin");
  user.run("u-globex-member", "globex", "member@globex.test", "member");

  const session = db.prepare("insert into sessions (token, user_id) values (?, ?)");
  session.run("tok-acme-member", "u-acme-member");
  session.run("tok-acme-admin", "u-acme-admin");
  session.run("tok-globex-member", "u-globex-member");

  const invoice = db.prepare("insert into invoices (id, tenant_id, amount_cents, note) values (?, ?, ?, ?)");
  invoice.run("inv-acme-1", "acme", 120_00, "acme quarterly hosting");
  invoice.run("inv-globex-1", "globex", 340_00, "globex private terms");

  const order = db.prepare("insert into orders (id, tenant_id, sku, quantity) values (?, ?, ?, ?)");
  order.run("ord-acme-1", "acme", "SKU-1", 2);
  order.run("ord-globex-1", "globex", "SKU-9", 5);
}
