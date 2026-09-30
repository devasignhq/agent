import { DatabaseSync } from "node:sqlite";
import { lookup as dnsLookup } from "node:dns/promises";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { migrate, seed } from "./db/schema.js";

const config = loadConfig();
const logger = createLogger((line) => console.log(line));

const db = new DatabaseSync(":memory:");
migrate(db);
seed(db);

const app = createApp({
  db,
  uploadsDir: config.uploadsDir,
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  fetchImpl: fetch,
  lookup: async (hostname: string) => (await dnsLookup(hostname)).address,
  allowedReportHosts: config.reportHosts,
  reportTimeoutMs: config.reportTimeoutMs,
  maxPageSize: config.pageSize,
  logger,
});

app.listen(config.port, () => logger.info("listening", { port: config.port }));
