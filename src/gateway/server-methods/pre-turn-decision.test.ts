import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPreTurnDecision,
  hasPreTurnDecider,
  registerPreTurnDecider,
  type PreTurnContext,
  type PreTurnPayload,
} from "./pre-turn-decision.js";

const CTX: PreTurnContext = { sessionKey: "s1", agentId: "a1", runId: "r1", channel: "web" };
const BASE: PreTurnPayload = { message: "hello", extraSystemPrompt: undefined };

afterEach(() => registerPreTurnDecider(null));

describe("applyPreTurnDecision (fail-closed seam)", () => {
  it("returns the payload unchanged when no decider is registered", async () => {
    expect(hasPreTurnDecider()).toBe(false);
    const out = await applyPreTurnDecision(BASE, CTX);
    expect(out).toEqual(BASE);
  });

  it("applies an augmenting decider", async () => {
    registerPreTurnDecider((p) => ({ ...p, extraSystemPrompt: "first slice" }));
    const out = await applyPreTurnDecision(BASE, CTX);
    expect(out.message).toBe("hello");
    expect(out.extraSystemPrompt).toBe("first slice");
  });

  it("supports async deciders", async () => {
    registerPreTurnDecider(async (p) => ({ ...p, message: `${p.message}!` }));
    const out = await applyPreTurnDecision(BASE, CTX);
    expect(out.message).toBe("hello!");
  });

  it("passes the context through to the decider", async () => {
    const spy = vi.fn((p: PreTurnPayload) => p);
    registerPreTurnDecider(spy);
    await applyPreTurnDecision(BASE, CTX);
    expect(spy).toHaveBeenCalledWith(BASE, CTX);
  });

  it("degrades to the original payload when the decider throws", async () => {
    registerPreTurnDecider(() => {
      throw new Error("boom");
    });
    const out = await applyPreTurnDecision(BASE, CTX);
    expect(out).toEqual(BASE);
  });

  it("degrades to the original payload when the decider rejects", async () => {
    registerPreTurnDecider(async () => {
      throw new Error("async boom");
    });
    const out = await applyPreTurnDecision(BASE, CTX);
    expect(out).toEqual(BASE);
  });

  it("degrades to the original payload when the decider exceeds the timeout", async () => {
    registerPreTurnDecider(
      () =>
        new Promise<PreTurnPayload>((resolve) =>
          setTimeout(() => resolve({ message: "late" }), 50),
        ),
    );
    const out = await applyPreTurnDecision(BASE, CTX, { timeoutMs: 5 });
    expect(out).toEqual(BASE);
  });

  it("degrades to the original payload when the decider returns a malformed value", async () => {
    registerPreTurnDecider(() => ({ notMessage: true }) as unknown as PreTurnPayload);
    const out = await applyPreTurnDecision(BASE, CTX);
    expect(out).toEqual(BASE);
  });
});
