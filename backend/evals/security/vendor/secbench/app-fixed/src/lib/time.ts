export function nowIso(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}

export function daysBetween(a: number, b: number): number {
  return Math.round(Math.abs(a - b) / 86_400_000);
}
