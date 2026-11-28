import { describe, expect, it } from "vitest";
import { validateChatSendParams } from "./index.js";

const base = { sessionKey: "main", message: "hello", idempotencyKey: "run-1" };

describe("chat.send params", () => {
  it("accepts a minimal send", () => {
    expect(validateChatSendParams(base)).toBe(true);
  });

  // The handler reads projectId and the Control UI sends it whenever a project
  // is active. The schema is closed, so it has to be declared.
  it("accepts projectId", () => {
    expect(validateChatSendParams({ ...base, projectId: "proj-1" })).toBe(true);
  });

  it("rejects an empty projectId", () => {
    expect(validateChatSendParams({ ...base, projectId: "" })).toBe(false);
  });

  it("still rejects unknown properties", () => {
    expect(validateChatSendParams({ ...base, nope: true })).toBe(false);
  });
});
