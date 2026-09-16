// Two reads whose failure mode is the whole point: the onboarding flow treats "the file
// is not there" and "we are still behind the base" as safe to write against, so anything
// else answering in their shape silently rewrites a maintainer's branch. Pure — no
// credentials, no network. Run:
//   node --import tsx/esm --test src/github/read-failure.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { behindByFrom, GitHubApiError, isMissingFileError } from "./app.js";

test("only a 404 means the file is absent", () => {
  assert.equal(isMissingFileError(new GitHubApiError(404, "/repos/a/b/contents/x", "Not Found")), true);
  assert.equal(isMissingFileError(new Error("gh text 404 on /repos/a/b/contents/.devasign.yml?ref=devasign/enable-verification")), true);

  // These are the ones that used to read as "not there" — and then the generated
  // defaults were written over whatever the maintainer had put on the branch.
  assert.equal(isMissingFileError(new Error("gh text 403 on /repos/a/b/contents/x")), false, "a secondary rate limit is not an empty file");
  assert.equal(isMissingFileError(new GitHubApiError(403, "/x", "rate limited")), false);
  assert.equal(isMissingFileError(new Error("gh text 500 on /repos/a/b/contents/x")), false);
  assert.equal(isMissingFileError(new GitHubApiError(502, "/x", "bad gateway")), false);
  assert.equal(isMissingFileError(new TypeError("fetch failed")), false);
  assert.equal(isMissingFileError(new Error("gh text 200 on /repos/404/404/contents/x")), false, "the status is the status, not any digits in the path");
});

test("a compare that does not state behind_by is not a compare that says zero", () => {
  assert.equal(behindByFrom({ behind_by: 0, ahead_by: 2 }), 0);
  assert.equal(behindByFrom({ behind_by: 3 }), 3);

  // 0 is what syncBranch reads as "caught up, safe to write".
  assert.equal(behindByFrom(undefined), null, "an empty body is what gh returns for a 204");
  assert.equal(behindByFrom(null), null);
  assert.equal(behindByFrom({}), null);
  assert.equal(behindByFrom({ status: "behind" }), null, "a shape change is not agreement");
  assert.equal(behindByFrom({ behind_by: "0" }), null);
  assert.equal(behindByFrom({ behind_by: 1.5 }), null);
  assert.equal(behindByFrom("behind_by: 0"), null);
});
