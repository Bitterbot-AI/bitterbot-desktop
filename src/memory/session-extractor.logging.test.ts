/**
 * Session fact extraction must not fail silently: when the LLM call throws
 * (network/auth/overload) the session's facts are never extracted, so the
 * failure is logged rather than swallowed into a bare null return.
 */
import { describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { extractSessionFacts } from "./session-extractor.js";

describe("extractSessionFacts logging", () => {
  it("warns and returns null when the LLM call fails", async () => {
    warn.mockClear();
    const result = await extractSessionFacts("User: hi", "/sessions/abc.jsonl", async () => {
      throw new Error("503 overloaded");
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain("/sessions/abc.jsonl");
    expect(msg).toContain("503 overloaded");
  });
});
