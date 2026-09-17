import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGatewayStore } from "../../stores/gateway-store";
import { SpendCard } from "./SpendCard";

const summary = {
  totals: { cost: { total: 365.64 }, usage: { total: 67_000_000 } },
  daily: [{ date: "2026-09-17", cost: 3.21, calls: 4 }],
  live: { window5h: { cost: 1.07, calls: 12, costPerHour: 0.6 } },
  cacheHealth: { warm: true, hitRate: 0.14, lastChatTs: Date.now() },
  budgets: {
    budgets: [
      {
        id: "global:daily",
        scope: "global",
        window: "daily",
        ratio: 0.42,
        level: 0,
        exceeded: false,
        limitUsd: 10,
      },
    ],
  },
  flags: [
    {
      id: "cache-never-read",
      level: "warn",
      message: "$27.84 of prompt cache was written and never read back",
    },
  ],
};

describe("SpendCard", () => {
  it("shows today, the 5h block, the 30-day total, cache state, budget and the loudest flag", async () => {
    const request = vi.fn(async () => summary);
    useGatewayStore.setState({ status: "connected", request, hello: null } as never);
    render(<SpendCard />);
    expect(await screen.findByText("$3.21")).toBeTruthy();
    expect(screen.getByText("$1.07")).toBeTruthy();
    expect(screen.getByText("$365.64")).toBeTruthy();
    expect(screen.getByText(/cache warm · 14% hit/)).toBeTruthy();
    expect(screen.getByText(/budget daily: 42% of \$10\.00/)).toBeTruthy();
    expect(screen.getByText(/never read back/)).toBeTruthy();
    expect(request).toHaveBeenCalledWith("usage.ledger.summary", { days: 30 });
  });

  it("renders nothing on a gateway without the ledger", () => {
    const request = vi.fn(async () => summary);
    useGatewayStore.setState({
      status: "connected",
      request,
      hello: { features: { methods: ["health"] } },
    } as never);
    const { container } = render(<SpendCard />);
    expect(container.querySelector('[data-testid="overview-spend-card"]')).toBeNull();
  });
});
