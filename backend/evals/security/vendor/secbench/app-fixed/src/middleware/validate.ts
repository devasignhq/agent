import type { NextFunction, Request, Response } from "express";

export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function safeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && !value.includes("..");
}

export function validateNameParam(req: Request, res: Response, next: NextFunction) {
  if (!safeSegment(String(req.params.name ?? ""))) {
    return void res.status(400).json({ error: "invalid_name" });
  }
  next();
}
