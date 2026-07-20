// Unit tests for the bounty criteria repo-context selector. This ranker has no
// live-traffic feedback loop — a silent regression here just makes criteria
// quietly worse — so the ordering rules are pinned explicitly.
//
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/bounties/criteria-context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DF_MIN_ENTRIES,
  type IndexedFile,
  renderRepoContext,
  selectRepoContext,
  SUMMARY_CHAR_CAP,
} from "./criteria-context.js";

function file(path: string, summary = "", exports: string[] = [], size = 1000): IndexedFile {
  return { path, summary, exports, size };
}

const paths = (files: IndexedFile[]) => files.map((f) => f.path);

test("an empty index yields nothing to render", () => {
  assert.deepEqual(selectRepoContext("anything at all", []), { files: [], manifest: [] });
});

test("a filename named in the issue outranks heavy token overlap", () => {
  const entries = [
    // Would win on tokens alone: matches "escrow", "funding" and "refund".
    file("src/services/escrow-funding-refund-helpers.ts", "escrow funding refund helpers", [
      "escrowFunding",
      "refund",
    ]),
    file("src/bounties/links.ts", "mints signed links"),
  ];
  const { files } = selectRepoContext(
    "The escrow funding refund flow breaks — see src/bounties/links.ts for the token",
    entries
  );
  assert.equal(files[0].path, "src/bounties/links.ts", "an explicitly named file must sort first");
});

test("a path hint matches even when its tokens are too short to survive tokenization", () => {
  const { files } = selectRepoContext("the writes in backend/src/db.ts are lost", [
    file("backend/src/db.ts", "postgres document store"),
    file("backend/src/server.ts", "express bootstrap"),
  ]);
  assert.equal(files[0].path, "backend/src/db.ts", "'db' is 2 chars and never becomes a token");
});

test("a path hint matches when the issue gives only a suffix", () => {
  const { files } = selectRepoContext("see bounties/keeper.ts", [
    file("backend/src/bounties/keeper.ts", "on-chain reconciler"),
  ]);
  assert.deepEqual(paths(files), ["backend/src/bounties/keeper.ts"]);
});

test("document-frequency damping drops a token that matches most of the index", () => {
  // "widget" appears in every summary, so it cannot discriminate; "rendering"
  // appears once, so it can. Needs >= DF_MIN_ENTRIES files for damping to apply.
  const entries = [
    ...Array.from({ length: 23 }, (_, i) => file(`src/mod-${i}.ts`, "a widget of some kind")),
    file("src/widget-only.ts", "a widget of some kind"),
    file("src/rendering.ts", "a widget of some kind"),
  ];
  assert.ok(entries.length >= DF_MIN_ENTRIES);
  const { files } = selectRepoContext("the widget rendering is wrong", entries);

  assert.ok(
    files.some((f) => f.path === "src/rendering.ts"),
    "the rare token must still rank its file"
  );
  assert.ok(
    !files.some((f) => f.path === "src/widget-only.ts"),
    "a file whose only signal is the over-frequent token must score zero and drop out"
  );
});

test("ties break by shorter path, then lexicographically", () => {
  const { files } = selectRepoContext("checkout flow", [
    file("src/deeply/nested/dir/checkout.ts", "checkout"),
    file("src/b/checkout.ts", "checkout"),
    file("src/a/checkout.ts", "checkout"),
  ]);
  assert.deepEqual(paths(files), ["src/a/checkout.ts", "src/b/checkout.ts", "src/deeply/nested/dir/checkout.ts"]);
});

test("an exported symbol named in the issue ranks its file", () => {
  const { files } = selectRepoContext("`recordFunding` never fires", [
    file("src/unrelated.ts", "nothing to do with it"),
    file("src/x.ts", "escrow bookkeeping", ["recordFunding", "submitFunding"]),
  ]);
  assert.equal(files[0].path, "src/x.ts");
});

test("when nothing scores, the manifest still provides a repo tour", () => {
  const entries = [
    file("src/alpha.ts", "alpha module", [], 5000),
    file("src/beta.ts", "beta module", [], 9000),
    file("README.md", "readme", [], 99999),
  ];
  const { files, manifest } = selectRepoContext("completely unrelated subject matter", entries);
  assert.deepEqual(files, [], "no lexical overlap means no ranked files");
  assert.deepEqual(
    manifest.map((m) => m.path),
    ["src/beta.ts", "src/alpha.ts"],
    "largest code files first; non-code is excluded"
  );
});

test("the manifest excludes files already shown in full", () => {
  const entries = [
    file("src/checkout.ts", "the checkout flow", [], 9000),
    file("src/other.ts", "something else", [], 8000),
  ];
  const { files, manifest } = selectRepoContext("checkout", entries);
  assert.deepEqual(paths(files), ["src/checkout.ts"]);
  assert.deepEqual(
    manifest.map((m) => m.path),
    ["src/other.ts"],
    "no file should appear twice in the prompt"
  );
});

test("caps are respected", () => {
  // 30 matches in a 150-file index stays under the DF cutoff, so the token survives.
  const entries = [
    ...Array.from({ length: 30 }, (_, i) =>
      file(`src/checkout-${String(i).padStart(2, "0")}.ts`, "checkout related", [], 1000 + i)
    ),
    ...Array.from({ length: 120 }, (_, i) => file(`src/filler-${i}.ts`, "unrelated module", [], 500 + i)),
  ];
  const { files, manifest } = selectRepoContext("checkout", entries, { files: 3, manifest: 5 });
  assert.equal(files.length, 3);
  assert.equal(manifest.length, 5);
});

test("long summaries are truncated in the manifest", () => {
  const { manifest } = selectRepoContext("unrelated", [file("src/a.ts", "x".repeat(SUMMARY_CHAR_CAP + 200))]);
  assert.ok(manifest[0].summary.length <= SUMMARY_CHAR_CAP);
  assert.ok(manifest[0].summary.endsWith("…"));
});

test("renderRepoContext emits repo_context sources and honours the char budget", () => {
  const selection = selectRepoContext("checkout", [
    file("src/checkout.ts", "the checkout flow", ["checkout"], 9000),
    file("src/other.ts", "something else", [], 8000),
  ]);
  const sources = renderRepoContext(selection);
  assert.ok(sources.length > 0);
  assert.ok(
    sources.every((s) => s.kind === "repo_context"),
    "the kind must be repo_context — repo_guidance means 'binding requirement' in the prompt"
  );
  assert.equal(sources[0].ref, "src/checkout.ts");
  assert.match(sources[0].text, /Exports: checkout/);

  assert.deepEqual(renderRepoContext(selection, 5), [], "a tiny budget drops everything rather than overflowing");
});
