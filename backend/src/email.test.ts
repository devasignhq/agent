// Escaping in the transactional mail templates. The markup is assembled by
// string interpolation, so every value that lands in it has to be neutralized
// here — the output renders in someone else's mail client, where we control
// nothing. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/email.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, accountPurgedHtml } from "./email.js";
import type { User } from "./types.js";

const userWith = (githubLogin: string): User =>
  ({
    id: "u_1",
    githubId: 42,
    githubLogin,
    email: "dev@example.com",
    plan: "free",
    createdAt: 0,
  }) as User;

test("escapeHtml covers every character that can break out of a tag or attribute", () => {
  assert.equal(escapeHtml(`<b>"x"&y'z</b>`), "&lt;b&gt;&quot;x&quot;&amp;y&#39;z&lt;/b&gt;");
  assert.equal(escapeHtml("plain text"), "plain text");
});

test("escapeHtml encodes an ampersand once, not twice", () => {
  // & runs first, so the entities it emits must not be re-encoded by the later
  // replacements — otherwise "&lt;" would come out as "&amp;lt;".
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml("&amp;"), "&amp;amp;", "a literal entity is escaped once");
});

test("accountPurgedHtml neutralizes a script payload in the login", () => {
  const html = accountPurgedHtml(userWith("<script>alert(1)</script>"));
  assert.ok(!html.includes("<script"), "no raw script tag reaches the mail body");
  // Assert the escaped form is present too: a test that only checks for absence
  // would still pass if the value were dropped instead of escaped.
  assert.ok(
    html.includes("Hi &lt;script&gt;alert(1)&lt;/script&gt;,"),
    "the login is escaped, not stripped"
  );
});

test("accountPurgedHtml neutralizes an attribute breakout in the login", () => {
  const html = accountPurgedHtml(userWith(`x" onmouseover="y`));
  assert.ok(!html.includes(`onmouseover="y`), "the handler can't survive intact");
  assert.ok(html.includes("Hi x&quot; onmouseover=&quot;y,"));
});

test("accountPurgedHtml leaves an ordinary login verbatim", () => {
  // Guards the other direction: over-escaping would mangle every real address.
  assert.ok(accountPurgedHtml(userWith("octocat")).includes("<p>Hi octocat,</p>"));
});
