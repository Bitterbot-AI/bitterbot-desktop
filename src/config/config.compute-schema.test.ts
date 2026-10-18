import { describe, expect, it } from "vitest";
import { FIELD_DEFAULTS } from "./schema.defaults.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { validateConfigObject } from "./validation.js";

describe("compute config (PLAN-57)", () => {
  it("accepts compute.enabled and the awareness block", () => {
    const res = validateConfigObject({
      compute: {
        enabled: false,
        awareness: { stateBlock: true, maxTokens: 160, creditFloor: 5, wakeBudgetPerHour: 10 },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.compute?.enabled).toBe(false);
      expect(res.config.compute?.awareness?.wakeBudgetPerHour).toBe(10);
    }
  });

  it("accepts an absent compute block", () => {
    expect(validateConfigObject({}).ok).toBe(true);
  });

  it("accepts the Phase 3 keys: pool trust, embedding routing and the egress class", () => {
    const res = validateConfigObject({
      compute: {
        pools: { lab: { trust: "trusted" }, proj: {} },
        embeddings: {
          provider: "pool",
          marginMs: 250,
          cooldownMs: 60_000,
          timeoutMs: 30_000,
          modelDigest: "sha256:abcdef0123",
        },
        egress: { transcriptsDefaultClass: "normal" },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.compute?.pools?.lab?.trust).toBe("trusted");
      expect(res.config.compute?.embeddings?.provider).toBe("pool");
    }
    expect(validateConfigObject({ compute: { pools: { lab: { trust: "local" } } } }).ok).toBe(
      false,
    );
    expect(validateConfigObject({ compute: { embeddings: { provider: "remote" } } }).ok).toBe(
      false,
    );
    expect(
      validateConfigObject({ compute: { egress: { transcriptsDefaultClass: "secret" } } }).ok,
    ).toBe(false);
    expect(FIELD_DEFAULTS["compute.embeddings.provider"]).toBe("pool");
    expect(FIELD_DEFAULTS["compute.egress.transcriptsDefaultClass"]).toBe("personal");
    expect(FIELD_LABELS["compute.embeddings.provider"]).toBe("Compute: Embedding Routing");
  });

  it("rejects unknown keys and out-of-range budgets (keys land with the code that reads them)", () => {
    expect(validateConfigObject({ compute: { paid: { enabled: true } } }).ok).toBe(false);
    expect(validateConfigObject({ compute: { awareness: { maxTokens: 10 } } }).ok).toBe(false);
    expect(validateConfigObject({ compute: { awareness: { wakeBudgetPerHour: -1 } } }).ok).toBe(
      false,
    );
  });

  it("is labelled and catalogued as default-on for the settings form", () => {
    expect(FIELD_LABELS["compute.enabled"]).toBe("Compute: Enabled");
    expect(FIELD_LABELS["compute.awareness.stateBlock"]).toBe("Compute: State Block in Prompt");
    expect(FIELD_LABELS["compute.awareness.wakeBudgetPerHour"]).toBe("Compute: Wakes per Hour");
    expect(FIELD_DEFAULTS["compute.enabled"]).toBe(true);
    expect(FIELD_DEFAULTS["compute.awareness.stateBlock"]).toBe(true);
  });
});
