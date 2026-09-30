import { Router } from "express";
import { parsePage } from "../lib/pagination.js";

export function ordersRouter(maxPageSize: number): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const page = parsePage(req.query as Record<string, unknown>, maxPageSize);
    res.json({ orders: req.repo!.orders.list(page.limit) });
  });

  router.get("/:orderId", (req, res) => {
    const order = req.repo!.orders.get(String(req.params.orderId));
    if (!order) return void res.status(404).json({ error: "not_found" });
    res.json({ order });
  });

  return router;
}
