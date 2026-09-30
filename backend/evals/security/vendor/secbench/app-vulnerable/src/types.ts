import type { Repositories } from "./db/repositories.js";
import type { SessionUser } from "./db/users.js";

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      repo?: Repositories;
      rawBody?: string;
    }
  }
}

export {};
