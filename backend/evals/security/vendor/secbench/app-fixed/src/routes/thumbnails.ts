import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateNameParam } from "../middleware/validate.js";

export function thumbnailsRouter(uploadsDir: string): Router {
  const router = Router();

  router.get("/:name", validateNameParam, async (req, res) => {
    const target = path.join(uploadsDir, "thumbnails", String(req.params.name));
    try {
      const body = await readFile(target, "utf8");
      res.type("text/plain").send(body);
    } catch {
      res.status(404).json({ error: "not_found" });
    }
  });

  return router;
}
