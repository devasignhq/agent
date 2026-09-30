export type Page = { limit: number; offset: number };

export function parsePage(query: Record<string, unknown>, maxLimit: number): Page {
  const limit = Number(query.limit ?? maxLimit);
  const offset = Number(query.offset ?? 0);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), maxLimit) : maxLimit,
    offset: Number.isFinite(offset) ? Math.max(Math.trunc(offset), 0) : 0,
  };
}
