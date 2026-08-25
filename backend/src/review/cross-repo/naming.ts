// Pure naming helpers for cross-repo matching: symbol spellings across language
// conventions, route literals, and the affix stripping that clusters repo families.

export function repoNameOf(fullName: string): string {
  const i = fullName.lastIndexOf("/");
  return i === -1 ? fullName : fullName.slice(i + 1);
}

export function ownerOf(fullName: string): string {
  const i = fullName.lastIndexOf("/");
  return i === -1 ? "" : fullName.slice(0, i);
}

export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

// Every spelling a sibling repo might use for the same symbol. The original is
// kept first so acronym casing (parseURL) survives the round trip.
export function symbolVariants(name: string): string[] {
  const raw = (name || "").trim();
  if (!raw) return [];
  const words = splitWords(raw);
  if (!words.length) return [];
  const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
  const camel = words[0] + words.slice(1).map(cap).join("");
  const pascal = words.map(cap).join("");
  const snake = words.join("_");
  return Array.from(
    new Set([raw, camel, pascal, snake, words.join("-"), snake.toUpperCase()].filter(Boolean))
  );
}

const HTTP_METHOD = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i;

// Searchable fragments of a route. Param syntax differs per framework (:id, {id},
// <id>, *), so the stable prefix before the first param is the portable needle.
export function routeLiterals(route: string): string[] {
  const path = (route || "").replace(HTTP_METHOD, "").trim();
  if (!path.startsWith("/")) return [];
  const stable = path.split(/\/[:{<*]/)[0] || path;
  return Array.from(
    new Set([path, stable, stable.replace(/^\//, "")].filter((s) => s.length > 1))
  );
}

export const LANGUAGE_AFFIXES = [
  "ts", "js", "node", "nodejs", "go", "golang", "py", "python", "rs", "rust",
  "java", "kotlin", "kt", "swift", "dotnet", "csharp", "cs", "rb", "ruby", "php", "cpp",
];

export const ROLE_AFFIXES = [
  "sdk", "client", "api", "server", "web", "app", "cli", "contract", "contracts",
  "frontend", "backend", "service", "lib", "core",
];

export type FamilyRole =
  | "sdk" | "client" | "api" | "server" | "web" | "app" | "cli"
  | "contract" | "frontend" | "backend" | "service" | "lib" | "core";

function stripSuffixes(name: string, affixes: string[]): string {
  let out = name;
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of affixes) {
      for (const sep of ["-", "_", "."]) {
        const suffix = sep + a;
        if (out.length > suffix.length && out.toLowerCase().endsWith(suffix)) {
          out = out.slice(0, -suffix.length);
          changed = true;
        }
      }
    }
  }
  return out;
}

export function stripFamilyAffixes(name: string, opts: { roles?: boolean } = {}): string {
  const base = stripSuffixes(name, LANGUAGE_AFFIXES);
  return opts.roles ? stripSuffixes(base, ROLE_AFFIXES) : base;
}

// Primary clustering key: language affixes only, so acme-sdk-ts and acme-sdk-go
// both land on acme-sdk while acme-sdk and acme-web stay apart.
export function familyStem(fullName: string): string {
  return stripFamilyAffixes(repoNameOf(fullName)).toLowerCase();
}

// Weaker fallback key: roles stripped too, so acme-sdk-go and acme-client-py
// still cluster. Only used when familyStem produces no group.
export function familyRoot(fullName: string): string {
  return stripFamilyAffixes(repoNameOf(fullName), { roles: true }).toLowerCase();
}

function trailingAffix(name: string, affixes: string[]): string | null {
  const lower = name.toLowerCase();
  for (const a of affixes) {
    for (const sep of ["-", "_", "."]) {
      if (lower.length > a.length + 1 && lower.endsWith(sep + a)) return a;
    }
  }
  return null;
}

export function roleOf(fullName: string): FamilyRole | null {
  const stem = stripSuffixes(repoNameOf(fullName), LANGUAGE_AFFIXES);
  const hit = trailingAffix(stem, ROLE_AFFIXES);
  if (!hit) return null;
  if (hit === "contracts") return "contract";
  return hit as FamilyRole;
}

export function languageAffixOf(fullName: string): string | null {
  return trailingAffix(repoNameOf(fullName), LANGUAGE_AFFIXES);
}

// Canonical slug for a feature id. Used both to key the parity probes and to
// match the slug the model echoes back, so the two can never drift apart.
export function slugify(name: string): string {
  return splitWords(name).join("-").slice(0, 60);
}
