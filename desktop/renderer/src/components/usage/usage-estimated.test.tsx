import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useUsageStore,
  type UsageEventRow,
  type UsageModelSummary,
} from "../../stores/usage-store";
import { formatUsdEstimate } from "./usage-format";
import { UsageLiveFeed } from "./UsageLiveFeed";
import { UsageModelsTable } from "./UsageModelsTable";

const totals = (cost: number) => ({
  calls: 2,
  errors: 0,
  usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 1000, reasoning: 0, total: 2000 },
  cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: cost, total: cost },
  costComputed: cost,
  computedCalls: 2,
  costReportedOnComputed: cost,
  reportedCalls: 0,
  cacheHitRate: 0,
  unpricedCalls: 0,
  estimatedCalls: 0,
});

function model(id: string, cost: number, sources: UsageModelSummary["pricingSources"]) {
  return {
    ...totals(cost),
    provider: "anthropic",
    model: id,
    kinds: ["chat"],
    pricingSources: sources,
    estimatedCalls: sources.includes("estimated") ? 2 : 0,
    lastTs: 1,
  } as UsageModelSummary;
}

describe("estimated costs in the Usage page", () => {
  beforeEach(() => {
    useUsageStore.setState({ costMode: "reported" } as never);
  });

  it("formats an estimate with a tilde and leaves known prices alone", () => {
    expect(formatUsdEstimate(0.112, true)).toBe("~$0.112");
    expect(formatUsdEstimate(0.112, false)).toBe("$0.112");
    expect(formatUsdEstimate(0, true)).toBe("$0.00");
  });

  it("marks an estimated model's cost as an estimate in the models table", () => {
    render(
      <UsageModelsTable
        models={[
          model("claude-fable-5-1", 0.112, ["estimated"]),
          model("claude-haiku-4-5", 0.25, ["provider"]),
        ]}
      />,
    );
    expect(screen.getByText("~$0.112")).toBeTruthy();
    expect(screen.getByText("≈ estimated")).toBeTruthy();
    expect(screen.getByText("$0.250")).toBeTruthy();
    expect(screen.queryByText("~$0.250")).toBeNull();
  });

  it("marks an estimated row in the live feed", () => {
    const event = {
      id: 1,
      ts: Date.now(),
      day: "2026-10-14",
      kind: "chat",
      feature: "agent/turn",
      provider: "anthropic",
      model: "claude-fable-5-1",
      usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 1000, reasoning: 0, total: 2000 },
      cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0.03, total: 0.03 },
      costSource: "estimated",
      status: "ok",
      batch: false,
    } as unknown as UsageEventRow;
    render(<UsageLiveFeed events={[event]} connected />);
    expect(screen.getByText("~$0.030")).toBeTruthy();
  });
});
