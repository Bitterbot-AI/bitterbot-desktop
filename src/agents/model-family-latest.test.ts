import { afterEach, describe, expect, it } from "vitest";
import { buildModelAliasLines } from "./model-alias-lines.js";
import {
  claudeFamilyVersion,
  recordServedModels,
  resetServedModelsForTest,
  resolveFamilyAliasTarget,
} from "./model-family-latest.js";
import { buildModelAliasIndex } from "./model-selection.js";

const served = [
  { provider: "anthropic", id: "claude-opus-4-8" },
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "anthropic", id: "claude-opus-5" },
  { provider: "anthropic", id: "claude-sonnet-5-5" },
  { provider: "anthropic", id: "claude-sonnet-4-5-20250929" },
  { provider: "openai", id: "gpt-5.5" },
];

afterEach(() => {
  resetServedModelsForTest();
});

describe("family shortcuts follow the newest served model", () => {
  it("parses Claude family ids, not dated snapshots", () => {
    expect(claudeFamilyVersion("claude-opus-5-5")).toEqual({ family: "opus", version: 505 });
    expect(claudeFamilyVersion("claude-fable-5")).toEqual({ family: "fable", version: 500 });
    expect(claudeFamilyVersion("claude-sonnet-4-5-20250929")).toBeUndefined();
    expect(claudeFamilyVersion("gpt-5.5")).toBeUndefined();
  });

  it("moves `opus` to the newest Opus once the catalog is known, and only then", () => {
    const ref = { provider: "anthropic", model: "claude-opus-4-8" };
    // Before the catalog loads: exactly as configured.
    expect(resolveFamilyAliasTarget("opus", ref)).toEqual(ref);
    recordServedModels(served);
    expect(resolveFamilyAliasTarget("opus", ref)).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    expect(resolveFamilyAliasTarget("Opus", ref).model).toBe("claude-opus-5-5");
  });

  it("never moves a pin, a cross-family alias, or to an older model", () => {
    recordServedModels(served);
    const opus48 = { provider: "anthropic", model: "claude-opus-4-8" };
    expect(resolveFamilyAliasTarget("opus48", opus48)).toEqual(opus48);
    expect(resolveFamilyAliasTarget("sonnet", opus48)).toEqual(opus48);
    const opus6 = { provider: "anthropic", model: "claude-opus-6" };
    expect(resolveFamilyAliasTarget("opus", opus6)).toEqual(opus6);
    const gpt = { provider: "openai", model: "gpt-5" };
    expect(resolveFamilyAliasTarget("opus", gpt)).toEqual(gpt);
  });

  it("the alias index and the agent's alias list both show the moved target", () => {
    recordServedModels(served);
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-8": { alias: "opus" },
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            "anthropic/claude-haiku-4-5": { alias: "fast" },
          },
        },
      },
    };
    const index = buildModelAliasIndex({ cfg, defaultProvider: "anthropic" });
    expect(index.byAlias.get("opus")?.ref.model).toBe("claude-opus-5-5");
    expect(index.byAlias.get("sonnet")?.ref.model).toBe("claude-sonnet-5-5");
    expect(index.byAlias.get("fast")?.ref.model).toBe("claude-haiku-4-5");
    expect(buildModelAliasLines(cfg)).toEqual([
      "- fast: anthropic/claude-haiku-4-5",
      "- opus: anthropic/claude-opus-5-5",
      "- sonnet: anthropic/claude-sonnet-5-5",
    ]);
  });

  it("keeps every alias as configured when an allowlist is on", () => {
    recordServedModels(served);
    const cfg = {
      agents: {
        defaults: {
          restrictModels: true,
          models: { "anthropic/claude-opus-4-8": { alias: "opus" } },
        },
      },
    };
    const index = buildModelAliasIndex({ cfg, defaultProvider: "anthropic" });
    expect(index.byAlias.get("opus")?.ref.model).toBe("claude-opus-4-8");
    expect(buildModelAliasLines(cfg)).toEqual(["- opus: anthropic/claude-opus-4-8"]);
  });
});

describe("doctor: shortcuts with a newer model of their family", () => {
  afterEach(() => {
    resetServedModelsForTest();
  });

  it("says where a family shortcut points now, and offers to move a pin", async () => {
    const { aliasFreshnessNotes } = await import("./model-family-latest.js");
    const { classifyAliasFreshness } = await import("../commands/doctor-model.js");
    recordServedModels(served);
    const models = {
      "anthropic/claude-opus-4-8": { alias: "opus" },
      "anthropic/claude-sonnet-4-6": { alias: "work" },
      "anthropic/claude-sonnet-5-5": { alias: "sonnet" },
      "openai/gpt-5": { alias: "gpt" },
    };
    const lines = classifyAliasFreshness(aliasFreshnessNotes(models, { restricted: false }));
    expect(lines).toEqual([
      {
        level: "info",
        message:
          'Shortcut "opus" now means anthropic/claude-opus-5-5 (configured as anthropic/claude-opus-4-8; family shortcuts follow the newest model).',
      },
      {
        level: "info",
        message:
          'Shortcut "work" is pinned to anthropic/claude-sonnet-4-6; anthropic/claude-sonnet-5-5 is newer. Point it there with: bitterbot models aliases add work anthropic/claude-sonnet-5-5',
      },
    ]);
    // With an allowlist, the family shortcut is a pin too.
    expect(
      aliasFreshnessNotes(models, { restricted: true }).find((n) => n.alias === "opus")?.follows,
    ).toBe(false);
  });
});
