import { describe, expect, it } from "vitest";
import {
  applyToolDescriptionOverrides,
  defaultHarnessPolicy,
  type HarnessPolicy,
  mergeActivePolicy,
  parseHarnessPolicy,
  policyDiffSummary,
  POLICY_LIMITS,
  renderPromptFragments,
  resolveHarnessPolicy,
} from "./harness-policy.js";

function withFragment(id: string, text: string, order = 0): HarnessPolicy {
  const p = defaultHarnessPolicy();
  p.prompt.fragments.push({ id, text, order });
  return p;
}

describe("parseHarnessPolicy (PLAN-25)", () => {
  it("whitelists known fields and drops forbidden/unknown keys structurally", () => {
    const parsed = parseHarnessPolicy({
      version: 3,
      provenance: "evolved",
      prompt: { fragments: [{ id: "a", text: "hi", order: 2 }] },
      tools: { descriptionOverrides: { foo: "better foo" } },
      // forbidden / unknown surfaces — must not appear anywhere in the result
      bashAllowlist: ["rm -rf /"],
      sandbox: { mode: "off" },
      acceptHighRiskDiff: true,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt.fragments).toEqual([{ id: "a", text: "hi", order: 2 }]);
    expect(parsed!.tools.descriptionOverrides).toEqual({ foo: "better foo" });
    expect(JSON.stringify(parsed)).not.toContain("bashAllowlist");
    expect(JSON.stringify(parsed)).not.toContain("acceptHighRiskDiff");
  });

  it("returns null for non-objects", () => {
    expect(parseHarnessPolicy(null)).toBeNull();
    expect(parseHarnessPolicy("nope")).toBeNull();
  });

  it("enforces caps: too many / oversized fragments are dropped", () => {
    const many = Array.from({ length: POLICY_LIMITS.maxFragments + 8 }, (_, i) => ({
      id: `f${i}`,
      text: "x",
      order: i,
    }));
    many.push({ id: "huge", text: "y".repeat(POLICY_LIMITS.maxFragmentLen + 1), order: 99 });
    const parsed = parseHarnessPolicy({ prompt: { fragments: many } });
    expect(parsed!.prompt.fragments.length).toBeLessThanOrEqual(POLICY_LIMITS.maxFragments);
    expect(parsed!.prompt.fragments.find((f) => f.id === "huge")).toBeUndefined();
  });

  it("drops duplicate fragment ids and blank fields", () => {
    const parsed = parseHarnessPolicy({
      prompt: {
        fragments: [
          { id: "a", text: "1" },
          { id: "a", text: "2" },
          { id: "", text: "z" },
        ],
      },
    });
    expect(parsed!.prompt.fragments).toEqual([{ id: "a", text: "1", order: 0 }]);
  });
});

describe("mergeActivePolicy", () => {
  it("keeps config-baseline compaction and takes evolved prompt/tools", () => {
    const baseline = resolveHarnessPolicy({
      agents: { defaults: { compaction: { mode: "safeguard", maxHistoryShare: 0.7 } } },
    } as never);
    const evolved = withFragment("f1", "do the thing");
    evolved.version = 5;
    evolved.provenance = "evolved";
    const merged = mergeActivePolicy(baseline, evolved);
    expect(merged.compaction).toEqual({ mode: "safeguard", maxHistoryShare: 0.7 });
    expect(merged.prompt.fragments).toEqual([{ id: "f1", text: "do the thing", order: 0 }]);
    expect(merged.version).toBe(5);
  });
});

describe("policyDiffSummary", () => {
  it("counts fragment adds and tool override changes; compaction is excluded", () => {
    const base = defaultHarnessPolicy();
    const cand = withFragment("f1", "x");
    cand.tools.descriptionOverrides = { foo: "y" };
    cand.compaction.mode = "safeguard"; // must NOT count toward the loop's diff
    const diff = policyDiffSummary(base, cand);
    expect(diff.changeCount).toBe(2);
    expect(diff.surfacesTouched.toSorted()).toEqual(["prompt", "tools"]);
  });

  it("identical policies have zero changes", () => {
    expect(policyDiffSummary(defaultHarnessPolicy(), defaultHarnessPolicy()).changeCount).toBe(0);
  });
});

describe("renderPromptFragments / applyToolDescriptionOverrides", () => {
  it("renders fragments ordered, empty by default (behavior-neutral)", () => {
    expect(renderPromptFragments(defaultHarnessPolicy())).toBe("");
    const p = defaultHarnessPolicy();
    p.prompt.fragments.push({ id: "b", text: "second", order: 2 });
    p.prompt.fragments.push({ id: "a", text: "first", order: 1 });
    expect(renderPromptFragments(p)).toBe("first\n\nsecond");
  });

  it("overrides only matching tool descriptions; identity with no overrides", () => {
    const tools = [
      { name: "memory_search", description: "old" },
      { name: "bash", description: "run" },
    ];
    expect(applyToolDescriptionOverrides(tools, defaultHarnessPolicy())).toEqual(tools);
    const p = defaultHarnessPolicy();
    p.tools.descriptionOverrides = { memory_search: "new desc", nonexistent: "ignored" };
    const out = applyToolDescriptionOverrides(tools, p);
    expect(out[0].description).toBe("new desc");
    expect(out[1].description).toBe("run");
  });
});
