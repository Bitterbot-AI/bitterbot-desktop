import { describe, expect, it } from "vitest";
import { classifyRunOrigin, isLearnableOrigin } from "./run-origin.js";

describe("classifyRunOrigin (PLAN-44 D-6)", () => {
  it("maps session-key shapes to trust classes", () => {
    expect(classifyRunOrigin("agent:main:main")).toBe("human");
    expect(classifyRunOrigin("agent:main")).toBe("human");
    expect(classifyRunOrigin("agent:main:whatsapp:+15551234567")).toBe("human");
    expect(classifyRunOrigin("agent:main:circle:abc")).toBe("circle");
    expect(classifyRunOrigin("agent:main:canvas:card1")).toBe("circle");
    expect(classifyRunOrigin("agent:main:a2a-task:0f9e")).toBe("a2a");
    expect(classifyRunOrigin("agent:main:subagent-x:1")).toBe("subagent");
    expect(classifyRunOrigin("agent:main:guest:zz")).toBe("guest");
    expect(classifyRunOrigin("agent:main:group:g1")).toBe("guest");
    expect(classifyRunOrigin("agent:main:cron:nightly")).toBe("system");
    expect(classifyRunOrigin("agent:main:hook:abc")).toBe("guest");
    // PLAN-44 Phase 3: validation rollouts execute candidate/peer text.
    expect(classifyRunOrigin("agent:main:skill-evolve-val-abc")).toBe("guest");
    expect(classifyRunOrigin("agent:main:skill-evolve-val-peer-abc")).toBe("guest");
    expect(classifyRunOrigin("hook:abc")).toBe("unknown");
    expect(classifyRunOrigin("agent:main:openai:uuid")).toBe("human");
    expect(classifyRunOrigin("agent:main:whatsapp:direct:+15551234567")).toBe("human");
    expect(classifyRunOrigin("skill-evolve:validation")).toBe("unknown");
    expect(classifyRunOrigin(null)).toBe("unknown");
    expect(classifyRunOrigin("")).toBe("unknown");
  });

  it("is case-insensitive and does not confuse an agent literally named circle", () => {
    expect(classifyRunOrigin("agent:Circle:main")).toBe("human");
    expect(classifyRunOrigin("AGENT:main:CIRCLE:1")).toBe("circle");
  });

  it("admits human and system only; fails closed on unknown and every third-party class", () => {
    expect(isLearnableOrigin("human")).toBe(true);
    expect(isLearnableOrigin("system")).toBe(true);
    for (const o of ["unknown", "circle", "a2a", "subagent", "guest"] as const) {
      expect(isLearnableOrigin(o)).toBe(false);
    }
  });
});
