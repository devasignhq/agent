// Ways a Playwright spec can be written that fail at run time however right the rest of it is.
// Each was seen live; the author is told once, with the fix, as it is for a syntax error.
const EDGE = /Edge from|react-flow__edge|rf__edge-/;
const DECLARED = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;
// A helper's text, up to the first line that only closes a block.
const FUNCTION = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)^[ \t]*\}[ \t]*$/gm;
const CLICK = /\.(?:click|dblclick)\(/;
const NARROWED = /\.(?:first|last)\(\)|\.nth\(\s*\d+\s*\)/;
const WAITS_VISIBLE = /\.waitFor\((?!\s*\{[^)]*state:\s*['"](?:attached|detached|hidden)['"])|toBeVisible\(/;
const UNSCOPED_ROLE = /\bpage\.getByRole\(\s*(['"])[a-z]+\1\s*\)\s*\.(?:first|last|nth)\(/;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const uses = (name: string) => new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`);
// Only locator-returning calls keep a line a line: `lines.count()` is a number. A helper
// that returns one hands it on when called.
const derives = (name: string) => new RegExp(`(?<![\\w$])${esc(name)}\\s*(?:\\(|\\.\\s*(?:locator|first|last|nth|filter|getBy\\w+)\\()`);
// A line with its strings emptied (a template keeps its `${}`), so a variable named
// `lines` is not found in the text `${count} lines`.
const code = (l: string) =>
  l.replace(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (s) => (s[0] === "`" ? (s.match(/\$\{[^}]*\}/g) ?? []).join(" ") : "''"));

/** What a Playwright spec will trip over at run time; empty for anything else. */
export function specLint(content: string, packages: Iterable<string>): string[] {
  if (!/from\s+['"]@playwright\/test['"]/.test(content)) return [];
  // A statement a formatter split over lines — a chain, or a declaration broken after its
  // `=` or `=>` — reads as one.
  const lines = content
    .replace(/\n\s*(?=[.)])/g, "")
    .replace(/(=>?)[ \t]*\n\s*/g, "$1 ")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l));
  const quote = (l: string) => `\`${l.trim().slice(0, 120)}\``;
  const problems: string[] = [];
  const unscoped = lines.find((l) => UNSCOPED_ROLE.test(l));
  if (unscoped) {
    problems.push(
      `it narrows a page-wide role query by position (${quote(unscoped)}): the first match can be an element elsewhere on the page, as a <select>'s options are. Scope the query to the container that owns it, or give it a name`
    );
  }
  if (![...packages].includes("@xyflow/react")) return problems;
  const joined = lines.join("\n");
  const named = [...joined.matchAll(DECLARED), ...joined.matchAll(FUNCTION)].map((m) => ({ name: m[1], body: m[2] }));
  // Names that hold a line — a locator built from one, or a helper returning one — and,
  // of those, the ones picked by position, which can be a line with an empty box.
  const lineVars = new Set<string>();
  const narrowed = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, body } of named) {
      // An awaited value is never a locator: `await lines.count()` is a number.
      if (lineVars.has(name) || /^\s*await\b/.test(body)) continue;
      const from = [...lineVars].filter((v) => derives(v).test(code(body)));
      if (!EDGE.test(body) && !from.length) continue;
      lineVars.add(name);
      if (NARROWED.test(body) || from.some((v) => narrowed.has(v))) narrowed.add(name);
      grew = true;
    }
  }
  const mentions = (l: string, names: Set<string>) => [...names].some((v) => uses(v).test(code(l)));
  const touchesLine = (l: string) => EDGE.test(l) || mentions(l, lineVars);
  const clicked = lines.find((l) => touchesLine(l) && CLICK.test(l));
  if (clicked) {
    problems.push(
      `it clicks a React Flow line (${quote(clicked)}): a line's box centre is its label or empty canvas, so the click lands elsewhere and selects nothing. Select a line with \`.press('Enter')\` on its group; if a criterion is about clicking a line, click a point on its path (\`getPointAtLength()\` inside \`evaluate\`, then \`page.mouse.click(x, y)\`)`
    );
  }
  const waited = lines.find((l) => WAITS_VISIBLE.test(l) && ((touchesLine(l) && NARROWED.test(l)) || mentions(l, narrowed)));
  if (waited) {
    problems.push(
      `it waits for a line picked by position to be visible (${quote(waited)}): a perfectly horizontal or vertical line has an empty box and never counts as visible. Wait for a line by name with \`waitFor({ state: 'attached' })\``
    );
  }
  return problems;
}
