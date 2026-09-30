import express from "express";
import type { Express } from "express";
import type { Db } from "./db/schema.js";
import { createLogger, type Logger } from "./logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requireAdmin, requireAuth } from "./middleware/auth.js";
import { withRepositories } from "./middleware/repositories.js";
import { adminRouter } from "./routes/admin.js";
import { filesRouter } from "./routes/files.js";
import { invoicesRouter } from "./routes/invoices.js";
import { ordersRouter } from "./routes/orders.js";
import { partnersRouter } from "./routes/partners.js";
import { reportsRouter } from "./routes/reports.js";
import { searchRouter } from "./routes/search.js";
import { thumbnailsRouter } from "./routes/thumbnails.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { createNotifier } from "./services/notify.js";
import "./types.js";

export type AppDeps = {
  db: Db;
  uploadsDir: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<string>;
  allowedReportHosts?: string[];
  reportTimeoutMs?: number;
  maxPageSize?: number;
  logger?: Logger;
};

export function createApp(deps: AppDeps): Express {
  const logger = deps.logger ?? createLogger();
  const maxPageSize = deps.maxPageSize ?? 25;
  const app = express();

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf.toString("utf8");
      },
    })
  );

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Signature-authenticated, so these are mounted before the session check.
  app.use("/webhooks", webhooksRouter(deps.db, deps.webhookSecret));
  app.use("/partners", partnersRouter(deps.db, deps.webhookSecret));

  app.use(requireAuth(deps.db));
  app.use(withRepositories(deps.db));

  app.use("/invoices", invoicesRouter(deps.db, createNotifier(logger), maxPageSize));
  app.use("/search", searchRouter(deps.db));
  app.use("/files", filesRouter(deps.uploadsDir));
  app.use("/thumbnails", thumbnailsRouter(deps.uploadsDir));
  app.use("/orders", ordersRouter(maxPageSize));
  app.use(
    "/reports",
    reportsRouter({
      fetchImpl: deps.fetchImpl ?? fetch,
      lookup: deps.lookup ?? (async (hostname: string) => hostname),
      allowedHosts: deps.allowedReportHosts ?? ["reports.example.com"],
      timeoutMs: deps.reportTimeoutMs ?? 5000,
    })
  );
  app.use("/admin", requireAdmin, adminRouter(deps.db));

  app.use(errorHandler);
  return app;
}
