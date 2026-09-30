// Local convenience script: drops a couple of rows into a scratch database so a
// developer has something to click through. Never imported by the service.
import { DatabaseSync } from "node:sqlite";
import { migrate, seed } from "../src/db/schema.js";

const tenant = process.argv[2] ?? "acme";
const label = process.argv[3] ?? "developer sandbox";

const db = new DatabaseSync(process.argv[4] ?? ":memory:");
migrate(db);
seed(db);

db.exec(
  `insert into invoices (id, tenant_id, amount_cents, note)
     values ('inv-dev-1', '${tenant}', 999, '${label}')`
);

console.log(db.prepare("select id, tenant_id, note from invoices order by id").all());
