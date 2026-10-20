import { describe, expect, it } from "vitest";
import { FIELD_DEFAULTS } from "./schema.defaults.js";
import { buildConfigSchema } from "./schema.js";
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

  it("accepts the Phase 4 paid keys with their caps, default off", () => {
    expect(
      validateConfigObject({
        compute: { paid: { enabled: true, maxUsdcPerJob: 2, maxUsdcPerDay: 10 } },
      }).ok,
    ).toBe(true);
    expect(validateConfigObject({ compute: { paid: { maxUsdcPerJob: -1 } } }).ok).toBe(false);
    expect(validateConfigObject({ compute: { paid: { autoFund: true } } }).ok).toBe(false);
    expect(FIELD_DEFAULTS["compute.paid.enabled"]).toBe(false);
    expect(FIELD_DEFAULTS["compute.paid.maxUsdcPerJob"]).toBe(5);
    expect(FIELD_DEFAULTS["compute.paid.maxUsdcPerDay"]).toBe(20);
    expect(FIELD_LABELS["compute.paid.enabled"]).toBe("Compute: Paid Jobs");
  });

  it("accepts the Phase 6 nudges switch, default on, and files compute under its own Settings group", () => {
    expect(validateConfigObject({ compute: { awareness: { nudges: false } } }).ok).toBe(true);
    expect(validateConfigObject({ compute: { awareness: { nudges: "yes" } } }).ok).toBe(false);
    expect(FIELD_DEFAULTS["compute.awareness.nudges"]).toBe(true);
    expect(FIELD_LABELS["compute.awareness.nudges"]).toBe("Compute: Hormonal Nudges");
    const hints = buildConfigSchema().uiHints;
    expect(hints.compute).toMatchObject({ label: "Compute", group: "Compute", order: 197 });
    expect(hints.compute?.help).toContain("compute.enabled is the one kill switch");
    expect(hints["compute.awareness.nudges"]?.label).toBe("Compute: Hormonal Nudges");
  });

  it("rejects unknown keys and out-of-range budgets (keys land with the code that reads them)", () => {
    expect(validateConfigObject({ compute: { local: { pool: true } } }).ok).toBe(false);
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
