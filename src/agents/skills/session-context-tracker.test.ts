import { describe, expect, it, beforeEach } from "vitest";
import {
  channelFromSessionKey,
  getRecentTurns,
  getSessionChannel,
  getToolHistory,
  getTurnNumber,
  recordTool,
  recordTurn,
  resetSessionContextTrackerForTest,
  setSessionChannel,
} from "./session-context-tracker.js";

describe("session-context-tracker", () => {
  beforeEach(() => resetSessionContextTrackerForTest());

  it("channelFromSessionKey parses known channel prefixes", () => {
    expect(channelFromSessionKey("discord:guild:chan")).toBe("discord");
    expect(channelFromSessionKey("telegram/12345")).toBe("telegram");
    expect(channelFromSessionKey("main")).toBe("internal");
    expect(channelFromSessionKey("")).toBe("internal");
  });

  it("getSessionChannel prefers stored channel over parsed", () => {
    setSessionChannel("main", "voice");
    expect(getSessionChannel("main")).toBe("voice");
  });

  it("turn counter increments on user turns only", () => {
    recordTurn("s", "user", "hi");
    recordTurn("s", "assistant", "hello");
    recordTurn("s", "user", "another");
    expect(getTurnNumber("s")).toBe(2);
  });

  it("recentTurns returns last N in chronological order", () => {
    recordTurn("s", "user", "u1");
    recordTurn("s", "assistant", "a1");
    recordTurn("s", "user", "u2");
    const turns = getRecentTurns("s", 5);
    expect(turns).toHaveLength(3);
    expect(turns[0]?.preview).toBe("u1");
    expect(turns[2]?.preview).toBe("u2");
  });

  it("recentTurns redacts emails and credit-card-shaped sequences", () => {
    recordTurn("s", "user", "email me at alice@example.com about 4111111111111111");
    const [t] = getRecentTurns("s", 1);
    expect(t?.preview).not.toContain("alice@example.com");
    expect(t?.preview).toContain("[redacted]");
  });

  it("toolHistory exposes recent tools with computed tsDelta", () => {
    recordTool("s", "memory_search", true);
    const [t] = getToolHistory("s", 5);
    expect(t?.tool).toBe("memory_search");
    expect(t?.success).toBe(true);
    expect(t?.tsDelta).toBeGreaterThanOrEqual(0);
  });

  it("turn ring buffer trims to MAX_TURNS_PER_SESSION (8)", () => {
    for (let i = 0; i < 20; i++) recordTurn("s", "user", `m${i}`);
    expect(getRecentTurns("s", 100).length).toBe(8);
  });
});
