import type { Logger } from "../logger.js";

export type Notifier = { invoiceViewed(tenantId: string, invoiceId: string): void };

export function createNotifier(logger: Logger): Notifier {
  return {
    invoiceViewed(tenantId, invoiceId) {
      logger.info("invoice viewed", { tenantId, invoiceId });
    },
  };
}
