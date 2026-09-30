import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";

export function filesRouter(uploadsDir: string): Router {
  const router = Router();

  router.get("/download/:name", async (req, res) => {
    const target = path.join(uploadsDir, String(req.params.name));
    try {
      const body = await readFile(target, "utf8");
      res.type("text/plain").send(body);
    } catch {
      res.status(404).json({ error: "not_found" });
    }
  });

  return router;
}
