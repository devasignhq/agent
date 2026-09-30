import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db/schema.js";
import { repositoriesFor } from "../db/repositories.js";

// Binds the request's repositories to the signed-in tenant once, so handlers
// below never have to pass a tenant id (and cannot pass someone else's).
export function withRepositories(db: Db) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.user) req.repo = repositoriesFor(db, req.user.tenantId);
    next();
  };
}
