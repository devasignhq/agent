// The API: /api/me answers only with the minted session, and CORS allows exactly one web origin.
import { createServer } from "node:http";
import { COOKIE, cookieValue, userOf } from "./session.mjs";

const port = Number(process.env.PORT || 4180);
const allowedOrigin = process.env.TWO_SERVER_ALLOWED_ORIGIN || "http://localhost:4181";

createServer((req, res) => {
  if (req.url === "/healthz") return void res.writeHead(200).end("ok");
  if (req.url !== "/api/me") return void res.writeHead(404).end();
  const token = cookieValue(req.headers.cookie, COOKIE);
  const user = token ? userOf(token) : null;
  // Deliberately noisy: the runner must scrub the session out of this log before upload.
  console.log(`GET /api/me origin=${req.headers.origin} ${COOKIE}=${token} -> ${user ? 200 : 401}`);
  res.writeHead(user ? 200 : 401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" });
  res.end(JSON.stringify(user ? { user } : { error: "signed_out" }));
}).listen(port, () => console.log(`api on http://localhost:${port}`));
