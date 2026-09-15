// The web app: a page that asks the API on another origin who is signed in.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4181);
const html = readFileSync(path.join(dir, "index.html"), "utf8");
createServer((req, res) => {
  if (req.url === "/healthz") return void res.writeHead(200).end("ok");
  res.writeHead(200, { "Content-Type": "text/html" }).end(html);
}).listen(port, () => console.log(`web on http://localhost:${port}`));
