import { describe, expect, it, beforeEach } from "vitest";
import type { InterventionRecord } from "./intervention-record.js";
import { signInterventionRecord, setInterventionSigner, __testing } from "./intervention-record.js";

function baseRec(): Omit<InterventionRecord, "sig"> {
  return {
    id: "rec-1",
    ts: 1000,
    sessionKey: "s",
    skill: "test-skill",
    interceptorId: "test-skill:default",
    stateSummary: {
      hormonal: {
        dopamine: 0.1,
        cortisol: 0.02,
        oxytocin: 0.2,
        response: {
          warmth: 0,
          energy: 0,
          focus: 0,
          playfulness: 0,
          verbosity: 0,
          curiosity: 0,
          assertiveness: 0,
          empathy: 0,
        },
      },
      gccrf: {
        predictionError: 0,
        learningProgress: 0,
        novelty: 0,
        empowerment: 0.5,
        strategicAlignment: 0.5,
        certaintyDelta: 0,
      },
      channel: "internal",
    },
    actionOriginal: { toolName: "memory_search", params: { q: "x" } },
    actionFinal: { toolName: "memory_search", params: { q: "x" } },
    intervention: { type: "noop" },
    metadata: { activationLatencyMs: 0.1, interventionLatencyMs: 0.2 },
  };
}

describe("intervention-record signing", () => {
  beforeEach(() => setInterventionSigner(null));

  it("falls back to unsigned-local when no signer is registered", () => {
    const r = signInterventionRecord(baseRec());
    expect(r.sig.pubkeyId).toBe("unsigned-local");
    expect(r.sig.ed25519).toBe("");
  });

  it("signs via the registered signer and produces a stable canonical form", () => {
    setInterventionSigner((canonical) => ({
      ed25519: `sig:${canonical.length}`,
      pubkeyId: "test-pubkey",
    }));
    const r = signInterventionRecord(baseRec());
    expect(r.sig.pubkeyId).toBe("test-pubkey");
    expect(r.sig.ed25519).toMatch(/^sig:\d+$/);
  });

  it("canonicalize produces identical output for equivalent records", () => {
    const a = __testing.canonicalize(baseRec());
    const b = __testing.canonicalize(baseRec());
    expect(a).toBe(b);
  });
});
