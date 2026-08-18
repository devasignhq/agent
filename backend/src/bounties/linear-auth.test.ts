import { test } from "node:test";
import assert from "node:assert/strict";
import { maybeHandleBountyLinearComment } from "./webhooks.js";
import type { Integration } from "../types.js";

test("maybeHandleBountyLinearComment rejects Linear bounty command from unauthorized non-privileged actor", () => {
  const mockIntegration: Integration = {
    id: "int_123",
    userId: "user_owner_456",
    provider: "linear",
    tokens: { accessToken: "token_123" },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const unauthorizedEvent = {
    data: {
      body: "bounty $500 7d",
      issueId: "issue_999",
      user: { id: "guest_user_789", admin: false },
    },
    actor: { id: "guest_user_789", admin: false },
  };

  const handled = maybeHandleBountyLinearComment(unauthorizedEvent, mockIntegration);
  assert.equal(handled, false, "Unauthorized Linear bounty command must be rejected and return false");
});
