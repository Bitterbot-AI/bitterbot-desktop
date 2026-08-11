/**
 * Wrapper markers must survive the whole wrapper stack.
 *
 * The before-tool-call wrapper tags its output with a NON-ENUMERABLE symbol so
 * `toToolDefinitions` knows the hook already ran with session context. Every
 * later wrapper rebuilt the tool with `{ ...tool }`, which does not copy
 * non-enumerable symbols, so the tag was erased on every real run (the abort
 * wrapper is unconditional in the embedded runner). The adapter then re-ran the
 * hook ITSELF, without ctx — so every PLAN-20 interceptor fired under session
 * key "__anon__", fired twice, and the outcome backfill (which matches records
 * by session key) could never tag a single intervention record.
 */
import { describe, expect, it, vi } from "vitest";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import { wrapToolWithCache } from "./pi-tools.cache.js";
import { wrapToolWithCapabilityEnforcer } from "./skills/capability-enforcer.js";

function baseTool() {
  return {
    name: "Read",
    execute: vi.fn().mockResolvedValue({ content: [], details: { ok: true } }),
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

describe("before-tool-call marker survives later wrappers", () => {
  it("survives the abort wrapper", () => {
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool(), { sessionKey: "agent:main:main" });
    const withAbort = wrapToolWithAbortSignal(wrapped, new AbortController().signal);
    expect(isToolWrappedWithBeforeToolCallHook(withAbort)).toBe(true);
  });

  it("survives the cache wrapper", () => {
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool(), { sessionKey: "agent:main:main" });
    const cache = {
      isCacheable: () => true,
      get: () => undefined,
      set: () => undefined,
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    expect(isToolWrappedWithBeforeToolCallHook(wrapToolWithCache(wrapped, cache))).toBe(true);
  });

  it("survives the capability enforcer", () => {
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool(), { sessionKey: "agent:main:main" });
    const enforced = wrapToolWithCapabilityEnforcer(wrapped, {
      activeP2PProfiles: () => [],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(isToolWrappedWithBeforeToolCallHook(enforced)).toBe(true);
  });

  it("survives the full stack in the order pi-tools.ts applies it", () => {
    const cache = {
      isCacheable: () => true,
      get: () => undefined,
      set: () => undefined,
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const stacked = wrapToolWithCache(
      wrapToolWithAbortSignal(
        wrapToolWithCapabilityEnforcer(
          wrapToolWithBeforeToolCallHook(baseTool(), { sessionKey: "agent:main:main" }),
          // oxlint-disable-next-line typescript/no-explicit-any
          { activeP2PProfiles: () => [] } as any,
        ),
        new AbortController().signal,
      ),
      cache,
    );
    expect(isToolWrappedWithBeforeToolCallHook(stacked)).toBe(true);
  });

  it("does not invent the marker on an unwrapped tool", () => {
    const withAbort = wrapToolWithAbortSignal(baseTool(), new AbortController().signal);
    expect(isToolWrappedWithBeforeToolCallHook(withAbort)).toBe(false);
  });
});
