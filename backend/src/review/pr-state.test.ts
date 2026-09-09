// The prState backfill: rows written before the field existed (or whose
// `pull_request.closed` webhook never arrived) learn their fate when a user
// opens them. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/review/pr-state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsPrStateBackfill } from "./pr-state.js";
import { prStateOf } from "./decisions.js";

test("needsPrStateBackfill: only rows that never resolved", () => {
  assert.equal(needsPrStateBackfill({ prState: undefined }), true);
  assert.equal(needsPrStateBackfill({ prState: "open" }), false);
  assert.equal(needsPrStateBackfill({ prState: "merged" }), false);
  assert.equal(needsPrStateBackfill({ prState: "closed" }), false);
});

// An open PR is re-fetched every 2.5s by the detail poll, so treating "open" as
// still-needing-backfill would storm the GitHub API.
test("needsPrStateBackfill: an already-open row is not re-polled", () => {
  assert.equal(needsPrStateBackfill({ prState: "open" }), false);
});

test("prStateOf maps a REST pull object to the stored lifecycle", () => {
  assert.equal(prStateOf({ state: "closed", merged: true }), "merged");
  assert.equal(prStateOf({ state: "closed", merged: false }), "closed");
  assert.equal(prStateOf({ state: "open", merged: false }), "open");
});
