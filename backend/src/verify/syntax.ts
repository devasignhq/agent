// A generated file that does not parse fails its whole batch: Playwright loads every spec in
// one run, so a single bad regex literal took two passing files down with it in a live run.
import { transformSync } from "esbuild";

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = { ts: "ts", mts: "ts", cts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx" };

/** Where a JS/TS file fails to parse, with the offending line; null when it parses or is not JS/TS. */
export function syntaxError(path: string, content: string): string | null {
  const loader = LOADERS[/\.([cm]?[jt]sx?)$/.exec(path)?.[1] ?? ""];
  if (!loader) return null;
  try {
    transformSync(content, { loader, format: "esm", logLevel: "silent" });
    return null;
  } catch (err) {
    const first = (err as { errors?: Array<{ text: string; location?: { line: number; lineText: string } | null }> }).errors?.[0];
    // No structured error means esbuild itself could not run, not that the file is wrong.
    if (!first) return null;
    const at = first.location ? ` at line ${first.location.line}: ${first.location.lineText.trim().slice(0, 160)}` : "";
    return `${first.text}${at}`;
  }
}
