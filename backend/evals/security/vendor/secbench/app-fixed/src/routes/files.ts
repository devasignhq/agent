import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";

export function filesRouter(uploadsDir: string): Router {
  const router = Router();
  const root = path.resolve(uploadsDir);

  router.get("/download/:name", async (req, res) => {
    const target = path.resolve(root, String(req.params.name));
    if (target !== root && !target.startsWith(root + path.sep)) {
      return void res.status(400).json({ error: "invalid_name" });
    }
    try {
      const body = await readFile(target, "utf8");
      res.type("text/plain").send(body);
    } catch {
      res.status(404).json({ error: "not_found" });
    }
  });

  return router;
}
