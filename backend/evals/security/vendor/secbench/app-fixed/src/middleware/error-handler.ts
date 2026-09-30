import type { NextFunction, Request, Response } from "express";
import { isHttpError } from "../lib/errors.js";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const status = isHttpError(err) ? err.status : 500;
  res.status(status).json({ error: status === 500 ? "internal_error" : (err as Error).message });
}
