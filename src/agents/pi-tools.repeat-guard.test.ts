import { beforeEach, describe, expect, it } from "vitest";
import {
  checkRepeatedCall,
  recordToolCallOutcome,
  REPEAT_BLOCK_AFTER,
  resetRepeatGuard,
  resetRepeatGuardForTest,
  toolCallFingerprint,
} from "./pi-tools.repeat-guard.js";

describe("repeat-call guard (B6)", () => {
  beforeEach(() => {
    resetRepeatGuardForTest();
  });

  it("fingerprints are order-insensitive over object keys and sensitive to values", () => {
    expect(toolCallFingerprint("read", { path: "a", b: 1 })).toBe(
      toolCallFingerprint("read", { b: 1, path: "a" }),
    );
    expect(toolCallFingerprint("read", { path: "a" })).not.toBe(
      toolCallFingerprint("read", { path: "b" }),
    );
    expect(toolCallFingerprint("read", { path: "a" })).not.toBe(
      toolCallFingerprint("write", { path: "a" }),
    );
  });

  it("blocks the call after REPEAT_BLOCK_AFTER identical failures and names the last error", () => {
    const call = {
      scope: "agent:main:main",
      toolName: "exec",
      args: { command: "cat missing.txt" },
    };
    for (let i = 0; i < REPEAT_BLOCK_AFTER; i++) {
      expect(checkRepeatedCall(call)).toEqual({ blocked: false });
      recordToolCallOutcome({ ...call, error: "cat: missing.txt: No such file or directory" });
    }
    const verdict = checkRepeatedCall(call);
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.failures).toBe(REPEAT_BLOCK_AFTER);
      expect(verdict.reason).toMatch(/^REPEATED-CALL: exec was called 3 times/);
      expect(verdict.reason).toMatch(/No such file/);
    }
  });

  it("different arguments are a different call; a success clears the streak", () => {
    const scope = "agent:main:main";
    const bad = { scope, toolName: "exec", args: { command: "x" } };
    for (let i = 0; i < REPEAT_BLOCK_AFTER; i++) {
      recordToolCallOutcome({ ...bad, error: "fail" });
    }
    expect(checkRepeatedCall({ scope, toolName: "exec", args: { command: "x --fixed" } })).toEqual({
      blocked: false,
    });
    recordToolCallOutcome({ ...bad, error: undefined });
    expect(checkRepeatedCall(bad)).toEqual({ blocked: false });
  });

  it("is scoped per session and reset on agent start", () => {
    const a = { scope: "agent:a", toolName: "read", args: { path: "p" } };
    const b = { scope: "agent:b", toolName: "read", args: { path: "p" } };
    for (let i = 0; i < REPEAT_BLOCK_AFTER; i++) {
      recordToolCallOutcome({ ...a, error: "e" });
    }
    expect(checkRepeatedCall(a).blocked).toBe(true);
    expect(checkRepeatedCall(b).blocked).toBe(false);
    resetRepeatGuard("agent:a");
    expect(checkRepeatedCall(a).blocked).toBe(false);
  });

  it("never blocks without a scope", () => {
    const call = { scope: undefined, toolName: "read", args: {} };
    for (let i = 0; i < REPEAT_BLOCK_AFTER + 1; i++) {
      recordToolCallOutcome({ ...call, error: "e" });
    }
    expect(checkRepeatedCall(call)).toEqual({ blocked: false });
  });
});
