import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db/schema.js";
import { userForToken } from "../db/users.js";

export function requireAuth(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = String(req.header("x-api-token") ?? "");
    const user = token ? userForToken(db, token) : null;
    if (!user) return void res.status(401).json({ error: "unauthenticated" });
    req.user = user;
    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return void res.status(403).json({ error: "forbidden" });
  next();
}
