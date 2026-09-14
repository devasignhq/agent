// CI checks out the PR head alone, one commit deep. There a history read fails, or misreads the
// head as a root commit: `git show --name-only` lists every file, `git diff-tree -r HEAD` none.
const Q = `['"\`]`;
const ARGV = `${Q}\\s*,\\s*(?:\\[\\s*)?${Q}`;
const SEP = `(?:\\s+|${ARGV})`;
// git as a command string, an argv's first string, or a `git` helper's call; options skipped.
const COMMAND = new RegExp(`(?:${Q}git${SEP}|\\bgit\\s*\\(\\s*(?:\\[\\s*)?${Q})((?:-[\\w-]+(?:=[^\\s'"\`]*)?${SEP})*)([a-z][\\w-]*)((?:[^'"\`\\n]|${ARGV})*)`, "g");
// Or handed to a helper of any name, as `execFileSync("git", args)` is.
const RUNS_GIT = new RegExp(`${COMMAND.source}|${Q}git${Q}\\s*,\\s*(?:\\[|\\.\\.\\.|[\\w$.]+\\s*[,)\\]])`);
const HISTORY = new Set(["log", "diff", "diff-tree", "show", "blame", "rev-list", "merge-base", "describe", "reflog", "shortlog", "whatchanged"]);
const REF = /\bHEAD(?:[\^~]|@\{)|@\{u(?:pstream)?\}|\b(?:origin|upstream)\/[\w.-]|\b(?:FETCH|ORIG)_HEAD\b|\bGITHUB_BASE_REF\b/;
const COMMENT = /^\s*(?:\/\/|#|\/?\*)/;

/** A generated test that reads the checkout's git history; empty when it reads none. */
export function historyLint(content: string): string[] {
  const lines = content.split("\n").filter((l) => !COMMENT.test(l));
  const code = lines.join("\n");
  if (!RUNS_GIT.test(code)) return [];
  const commands = [...code.matchAll(COMMAND)].map((m) => ({ sub: m[2], text: `git ${m[1]}${m[2]}${m[3]}`.replace(new RegExp(ARGV, "g"), " ") }));
  // A repository the test builds itself has whatever history the test gave it.
  if (commands.some((c) => c.sub === "init" || c.sub === "clone")) return [];
  const read = commands.find((c) => HISTORY.has(c.sub))?.text ?? lines.find((l) => REF.test(l));
  if (!read) return [];
  return [
    `it reads git history (\`${read.trim().replace(/\s+/g, " ").slice(0, 120)}\`), but CI checks out the PR head alone, one commit deep: there is no parent commit or base branch, so a command like that fails on every attempt or misreads the head as the first commit. Assert on what the files in the checkout hold instead; code under test that runs git needs a repository the test creates itself with \`git init\` in a temporary directory`,
  ];
}
