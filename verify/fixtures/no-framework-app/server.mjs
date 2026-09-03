// Tiny app with no test framework and no CI: the "bundled runner" fixture.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatTotal } from "./src/total.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const html = readFileSync(path.join(dir, "index.html"), "utf8")
  .replace("{{total}}", formatTotal(123456))
  .replace("{{refunds}}", process.env.HIDE_REFUNDS ? "" : '<p data-testid="refunds">Refunds: $12.00</p>');
createServer((req, res) => {
  if (req.url === "/healthz") return void res.writeHead(200).end("ok");
  res.writeHead(200, { "Content-Type": "text/html" }).end(html);
}).listen(port, () => console.log(`fixture app on http://localhost:${port}`));
