// Shared static catalogues for the install / IDE / CLI surfaces. Lives in its
// own file so both the onboarding wizard and Settings → Installation can
// import them without one file having to depend on the other.

export type IDEOption = {
  key: string;
  name: string;
  store: string;
  url: string;
};

export type CLICommand = { c: string; d: string };
export type CLIOption = {
  key: string;
  name: string;
  install: string;
  commands: CLICommand[];
};

export type HowStep = {
  icon: string;
  title: string;
  body: string;
};

export const IDE_OPTIONS: IDEOption[] = [
  { key: "cursor",      name: "Cursor",      store: "Cursor Marketplace",       url: "cursor://anysphere.cursor-deeplink/extension/devasign.review" },
  { key: "antigravity", name: "Antigravity", store: "Antigravity Plugin Hub",   url: "antigravity://plugins/install?id=devasign" },
  { key: "vscode",      name: "VS Code",     store: "VS Code Marketplace",      url: "vscode:extension/devasign.review" },
  { key: "zed",         name: "Zed",         store: "Zed Extensions",           url: "zed://extensions/devasign-review" },
  { key: "jetbrains",   name: "JetBrains",   store: "JetBrains Marketplace",    url: "https://plugins.jetbrains.com/plugin/devasign-review" },
];

export const CLI_OPTIONS: CLIOption[] = [
  {
    key: "claude-code", name: "Claude Code",
    install: "claude code install devasign",
    commands: [
      { c: "devasign review",            d: "Run review on the current branch's open PR." },
      { c: "devasign goal pull",         d: "Sync ticket + Loom + Figma context into ./.devasign." },
      { c: "devasign explain <file>",    d: "Ask why a file changed against the goal." },
      { c: "devasign post",              d: "Push inline review comments back to GitHub." },
    ],
  },
  {
    key: "gemini-cli",  name: "Gemini CLI",
    install: "gemini extensions add devasign",
    commands: [
      { c: "gemini devasign review",     d: "Review the staged diff via Gemini 2.5 Pro." },
      { c: "gemini devasign context",    d: "Print resolved goal context for current branch." },
      { c: "gemini devasign watch",      d: "Re-review on every commit until checks pass." },
    ],
  },
  {
    key: "open-code",   name: "Open Code",
    install: "opencode plugin add devasign",
    commands: [
      { c: "opencode review",            d: "Local review using your configured model." },
      { c: "opencode review --against main", d: "Diff against a base branch you pick." },
      { c: "opencode goal show",         d: "Inspect parsed acceptance criteria." },
    ],
  },
  {
    key: "codex",       name: "Codex CLI",
    install: "codex install devasign",
    commands: [
      { c: "codex devasign run",         d: "One-shot review on the working tree." },
      { c: "codex devasign apply",       d: "Auto-apply safe fixes (rename, lint, types)." },
      { c: "codex devasign sign-off",    d: "Mark blockers resolved once addressed." },
    ],
  },
];

export const HOW_IT_WORKS: HowStep[] = [
  {
    icon: "doc",
    title: "1. Ingest the goal",
    body: "Pulls the linked ticket, Loom transcript, Figma frame and screenshots into a single goal artifact. OCR + Whisper run locally; only structured text leaves your machine.",
  },
  {
    icon: "git",
    title: "2. Watch the diff",
    body: "On PR open or push, the agent reads the diff against the goal — not just the code. It maps changed files to acceptance criteria and flags drift, missing states, and untested paths.",
  },
  {
    icon: "brain",
    title: "3. Reason with your model",
    body: "Diff + goal context are sent to the LLM you picked (Claude, Gemini, GPT, local). DevAsign never trains on your code and never stores prompts past the review window.",
  },
  {
    icon: "message",
    title: "4. Post inline + summary",
    body: "Comments land as GitHub review threads with file/line anchors. A top-level summary lists met / unmet criteria and any blockers — re-trigger by pushing or commenting /devasign review.",
  },
];
