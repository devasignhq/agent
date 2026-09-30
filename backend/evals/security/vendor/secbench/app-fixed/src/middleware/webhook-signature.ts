import type { NextFunction, Request, Response } from "express";
import { signatureMatches } from "../lib/hmac.js";

export function requireWebhookSignature(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("x-signature") ?? undefined;
    if (!signatureMatches(secret, req.rawBody ?? "", header)) {
      return void res.status(401).json({ error: "bad_signature" });
    }
    next();
  };
}
