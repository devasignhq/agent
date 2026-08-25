// ghPaged follows Link headers, so it is the one helper where a URL from a
// response could steer the installation token off-site. Pure — the guard runs
// before any token is minted, so this needs no credentials and no network. Run:
//   node --import tsx/esm --test src/github/gh-paged-host.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGitHubApiUrl, ghPaged, parseNextLink } from "./app.js";

test("assertGitHubApiUrl accepts the GitHub API host", () => {
  assert.doesNotThrow(() => assertGitHubApiUrl("https://api.github.com/installation/repositories"));
});

test("assertGitHubApiUrl rejects any other host", () => {
  for (const url of [
    "https://evil.example.com/installation/repositories",
    "https://api.github.com.evil.example.com/x",
    "http://localhost:8787/x",
    "https://raw.githubusercontent.com/x",
  ]) {
    assert.throws(() => assertGitHubApiUrl(url), /Refusing to send an installation token/, url);
  }
});

test("assertGitHubApiUrl rejects an unparseable URL", () => {
  assert.throws(() => assertGitHubApiUrl("not a url"), /Invalid GitHub API URL/);
});

test("ghPaged refuses an off-site URL before minting a token", async () => {
  // No API credentials are configured here; reaching installationToken would
  // throw a different error, so this passing proves the guard runs first.
  await assert.rejects(
    () => ghPaged(1, "https://evil.example.com/installation/repositories"),
    /Refusing to send an installation token to evil\.example\.com/
  );
});

test("parseNextLink reads only the rel=next target", () => {
  const link =
    '<https://api.github.com/installation/repositories?page=2>; rel="next", ' +
    '<https://api.github.com/installation/repositories?page=9>; rel="last"';
  assert.equal(parseNextLink(link), "https://api.github.com/installation/repositories?page=2");
  assert.equal(parseNextLink('<https://api.github.com/x?page=9>; rel="last"'), null);
  assert.equal(parseNextLink(null), null);
  assert.equal(parseNextLink(undefined), null);
});
