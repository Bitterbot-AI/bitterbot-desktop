/**
 * PLAN-13 Phase B.5: tests for the runtime capability enforcer.
 *
 * Coverage:
 *  - non-sensitive tool calls always pass
 *  - empty active set is a no-op (preserves agent baseline)
 *  - sensitive call denied when no active skill permits it
 *  - sensitive call allowed when at least one active skill permits it
 *    (union semantics)
 *  - reputation hook + notification hook fire on deny
 *  - host-scoped network rules (suffix match)
 *  - wrapper composes cleanly with other wrappers (idempotent flagging)
 */

import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDenied,
  evaluateToolCall,
  isToolWrappedWithCapabilityEnforcer,
  wrapToolWithCapabilityEnforcer,
  wrapToolsWithCapabilityEnforcer,
  __testing,
  type EnforcerContext,
} from "./capability-enforcer.js";
import { resolveCapabilityProfile, type EffectiveCapabilityProfile } from "./capability-profile.js";

const VERIFIED_WALLET_PROFILE: EffectiveCapabilityProfile = resolveCapabilityProfile({
  tier: "verified",
  declared: { wallet: true },
});

const PROVISIONAL_NO_WALLET_PROFILE: EffectiveCapabilityProfile = resolveCapabilityProfile({
  tier: "provisional",
  declared: { wallet: false },
});

const VERIFIED_HOST_PROFILE: EffectiveCapabilityProfile = resolveCapabilityProfile({
  tier: "verified",
  declared: { network: { outbound: ["api.openweathermap.org"] } },
});

function makeTool(name: string, exec = vi.fn(async () => "ok")) {
  return {
    name,
    description: name,
    parameters: { type: "object" as const, properties: {}, additionalProperties: false },
    execute: exec,
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

describe("evaluateToolCall", () => {
  it("non-sensitive tool always passes", () => {
    const ctx: EnforcerContext = { activeP2PProfiles: () => [] };
    expect(evaluateToolCall("read_file", {}, ctx)).toBeNull();
    expect(evaluateToolCall("web_search", {}, ctx)).toBeNull();
    expect(evaluateToolCall("memory_recall", {}, ctx)).toBeNull();
  });

  it("empty active set means the enforcer is a no-op even for sensitive tools", () => {
    const ctx: EnforcerContext = { activeP2PProfiles: () => [] };
    expect(evaluateToolCall("wallet", { action: "send_usdc" }, ctx)).toBeNull();
    expect(evaluateToolCall("exec", { cmd: "ls" }, ctx)).toBeNull();
  });

  it("wallet call denied when only provisional skill is active", () => {
    const ctx: EnforcerContext = {
      activeP2PProfiles: () => [PROVISIONAL_NO_WALLET_PROFILE],
    };
    const denial = evaluateToolCall("wallet", { action: "send_usdc" }, ctx);
    expect(denial).toBeInstanceOf(CapabilityDenied);
    expect(denial?.capability).toBe("wallet");
  });

  it("wallet call allowed when at least one active skill grants wallet", () => {
    const ctx: EnforcerContext = {
      activeP2PProfiles: () => [PROVISIONAL_NO_WALLET_PROFILE, VERIFIED_WALLET_PROFILE],
    };
    expect(evaluateToolCall("wallet", { action: "send_usdc" }, ctx)).toBeNull();
  });

  it("network call denied for off-list host even when on-list host is permitted", () => {
    const ctx: EnforcerContext = {
      activeP2PProfiles: () => [VERIFIED_HOST_PROFILE],
    };
    const ok = evaluateToolCall(
      "web_fetch",
      { url: "https://api.openweathermap.org/data/2.5" },
      ctx,
    );
    const bad = evaluateToolCall("web_fetch", { url: "https://attacker.example.com/steal" }, ctx);
    expect(ok).toBeNull();
    expect(bad).toBeInstanceOf(CapabilityDenied);
    expect(bad?.capability).toBe("network");
    expect(bad?.scope?.host).toBe("attacker.example.com");
  });

  it("shell tools denied unless active set permits", () => {
    const ctx: EnforcerContext = {
      activeP2PProfiles: () => [PROVISIONAL_NO_WALLET_PROFILE],
    };
    expect(evaluateToolCall("exec", { cmd: "ls" }, ctx)).toBeInstanceOf(CapabilityDenied);
    expect(evaluateToolCall("sessions_spawn", {}, ctx)).toBeInstanceOf(CapabilityDenied);
  });

  it("malformed url params don't crash the scope extractor", () => {
    const ctx: EnforcerContext = {
      activeP2PProfiles: () => [VERIFIED_HOST_PROFILE],
    };
    // No host extractable; profileAllows treats as "any scope" and the
    // declared list is non-empty so the call is permitted.
    expect(evaluateToolCall("web_fetch", { url: "::not-a-url" }, ctx)).toBeNull();
  });
});

describe("wrapToolWithCapabilityEnforcer", () => {
  it("allows the underlying execute when the call is permitted", async () => {
    const inner = vi.fn(async () => "result");
    const tool = makeTool("read_file", inner);
    const ctx: EnforcerContext = { activeP2PProfiles: () => [] };
    const wrapped = wrapToolWithCapabilityEnforcer(tool, ctx);
    expect(isToolWrappedWithCapabilityEnforcer(wrapped)).toBe(true);
    const result = await wrapped.execute("call-1", {}, new AbortController().signal, undefined);
    expect(result).toBe("result");
    expect(inner).toHaveBeenCalledOnce();
  });

  it("throws CapabilityDenied and skips inner execute on deny", async () => {
    const inner = vi.fn(async () => "should-not-run");
    const tool = makeTool("wallet", inner);
    const recordDenial = vi.fn();
    const notifyDenial = vi.fn();
    const ctx: EnforcerContext = {
      activeP2PProfiles: () => [PROVISIONAL_NO_WALLET_PROFILE],
      recordDenial,
      notifyDenial,
    };
    const wrapped = wrapToolWithCapabilityEnforcer(tool, ctx);
    await expect(
      wrapped.execute("call-2", { action: "send_usdc" }, new AbortController().signal, undefined),
    ).rejects.toBeInstanceOf(CapabilityDenied);
    expect(inner).not.toHaveBeenCalled();
    expect(recordDenial).toHaveBeenCalledOnce();
    expect(recordDenial).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "wallet", capability: "wallet" }),
    );
    expect(notifyDenial).toHaveBeenCalledOnce();
    expect(notifyDenial.mock.calls[0]?.[0]).toMatch(/wallet/);
  });

  it("recordDenial / notifyDenial throwing does not block the deny path", async () => {
    const tool = makeTool("wallet");
    const ctx: EnforcerContext = {
      activeP2PProfiles: () => [PROVISIONAL_NO_WALLET_PROFILE],
      recordDenial: () => {
        throw new Error("rep-down");
      },
      notifyDenial: () => {
        throw new Error("notify-down");
      },
    };
    const wrapped = wrapToolWithCapabilityEnforcer(tool, ctx);
    // Still throws CapabilityDenied; secondary failures are swallowed.
    await expect(
      wrapped.execute("c", {}, new AbortController().signal, undefined),
    ).rejects.toBeInstanceOf(CapabilityDenied);
  });
});

describe("wrapToolsWithCapabilityEnforcer", () => {
  it("returns tools unchanged when ctx is undefined", () => {
    const tools = [makeTool("a"), makeTool("b")];
    const out = wrapToolsWithCapabilityEnforcer(tools, undefined);
    expect(out).toBe(tools);
    expect(isToolWrappedWithCapabilityEnforcer(out[0]!)).toBe(false);
  });

  it("wraps every tool when ctx is provided", () => {
    const tools = [makeTool("a"), makeTool("b")];
    const out = wrapToolsWithCapabilityEnforcer(tools, {
      activeP2PProfiles: () => [],
    });
    expect(out.length).toBe(2);
    expect(isToolWrappedWithCapabilityEnforcer(out[0]!)).toBe(true);
    expect(isToolWrappedWithCapabilityEnforcer(out[1]!)).toBe(true);
  });
});

describe("classification + union helpers", () => {
  it("unions empty profile array to the deny baseline", () => {
    const u = __testing.unionProfile([]);
    expect(u.wallet).toBe(false);
    expect(u.shell).toBe(false);
    expect(u.process).toBe(false);
    expect(u.network.outbound).toEqual([]);
    expect(u.fs.read).toEqual([]);
    expect(u.fs.write).toEqual([]);
  });

  it("unions multiple profiles by OR-ing booleans and concatenating lists", () => {
    // Construct profiles directly so we exercise unionProfile in isolation
    // (the resolver fills tier baselines for unstated axes which would
    // confound the OR test).
    const a: EffectiveCapabilityProfile = {
      network: { outbound: ["a.com"] },
      fs: { read: ["/a"], write: [] },
      wallet: true,
      shell: false,
      process: false,
    };
    const b: EffectiveCapabilityProfile = {
      network: { outbound: ["b.com"] },
      fs: { read: ["/b"], write: ["/b"] },
      wallet: false,
      shell: true,
      process: false,
    };
    const u = __testing.unionProfile([a, b]);
    expect(u.network.outbound.toSorted()).toEqual(["a.com", "b.com"]);
    expect(u.fs.read.toSorted()).toEqual(["/a", "/b"]);
    expect(u.fs.write).toEqual(["/b"]);
    expect(u.wallet).toBe(true);
    expect(u.shell).toBe(true);
    expect(u.process).toBe(false);
  });

  it("classifies wallet variants", () => {
    expect(__testing.classifyTool("wallet")?.capability).toBe("wallet");
    expect(__testing.classifyTool("wallet_send")?.capability).toBe("wallet");
    expect(__testing.classifyTool("wallet.send_usdc")?.capability).toBe("wallet");
    expect(__testing.classifyTool("wallet_get_balance")?.capability).toBe("wallet");
  });

  it("classifies shell-class tools per dangerous-tools.ts", () => {
    expect(__testing.classifyTool("exec")?.capability).toBe("shell");
    expect(__testing.classifyTool("shell")?.capability).toBe("shell");
    expect(__testing.classifyTool("sessions_spawn")?.capability).toBe("shell");
    expect(__testing.classifyTool("gateway")?.capability).toBe("shell");
  });

  it("classifies network tools", () => {
    expect(__testing.classifyTool("web_fetch")?.capability).toBe("network");
    expect(__testing.classifyTool("fetch_url")?.capability).toBe("network");
    expect(__testing.classifyTool("http_get")?.capability).toBe("network");
  });

  it("does not classify non-sensitive tools", () => {
    expect(__testing.classifyTool("read_file")).toBeNull();
    expect(__testing.classifyTool("memory_recall")).toBeNull();
    expect(__testing.classifyTool("web_search")).toBeNull(); // search != fetch
  });
});
