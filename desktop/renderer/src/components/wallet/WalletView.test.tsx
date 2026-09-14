/**
 * PLAN-49 Phase 1: the wallet presents dollars + a plain-English ledger by
 * default, with crypto details behind a toggle; payments.fiat.uiDollars=false
 * falls back to the crypto-first view.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWalletStore } from "../../stores/wallet-store";
import { WalletView } from "./WalletView";

const requestMock = vi.fn();
vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({ request: requestMock, status: "connected" }),
}));

const ADDR = "0x1593000000000000000000000000000000000000";

function baseConfig(uiDollars: boolean) {
  return {
    enabled: true,
    network: "base",
    sessionSpendCapUsd: 50,
    perTransactionCapUsd: 25,
    dailySpendLimitUsd: 50,
    x402Enabled: false,
    x402MaxPerRequestUsd: 1,
    stripeOnrampEnabled: true,
    uiDollars,
  };
}

const moneyView = {
  balanceUsd: 18.6,
  currency: "USD" as const,
  entries: [
    {
      kind: "spent",
      amountUsd: 0.4,
      at: Date.now(),
      deltaUsd: -0.4,
      description: "Paid a peer agent",
    },
    {
      kind: "funded",
      amountUsd: 20,
      at: Date.now() - 1000,
      deltaUsd: 20,
      description: "Added funds via Coinbase",
    },
  ],
  totals: { fundedUsd: 20, spentUsd: 0.4, earnedUsd: 0, withdrawnUsd: 0, feesUsd: 0 },
  note: "Your balance is the live on-chain total.",
};

function setup(uiDollars: boolean) {
  requestMock.mockImplementation((method: string, params?: { token?: string }) => {
    switch (method) {
      case "wallet.getConfig":
        return Promise.resolve(baseConfig(uiDollars));
      case "wallet.getAddress":
        return Promise.resolve({ address: ADDR, network: "base" });
      case "wallet.getBalance":
        return params?.token === "ETH"
          ? Promise.resolve({ token: "ETH", balance: "0.01" })
          : Promise.resolve({ token: "USDC", balance: "18.6" });
      case "wallet.getHistory":
        return Promise.resolve({ transactions: [] });
      case "wallet.getMoneyView":
        return Promise.resolve(moneyView);
      default:
        return Promise.resolve({});
    }
  });
}

beforeEach(() => {
  requestMock.mockReset();
  useWalletStore.getState().reset();
});

describe("WalletView — dollar view (PLAN-49 Phase 1)", () => {
  it("shows a dollar balance + plain-English activity, crypto hidden by default", async () => {
    setup(true);
    render(<WalletView />);
    await waitFor(() => expect(screen.getByText("$18.60")).toBeTruthy());
    // Plain-English ledger, not tx hashes.
    expect(screen.getByText("Paid a peer agent")).toBeTruthy();
    expect(screen.getByText("Added funds via Coinbase")).toBeTruthy();
    // Crypto details (the raw wallet address) are hidden until toggled.
    expect(screen.queryByText(ADDR)).toBeNull();
    expect(screen.getByText(/Show crypto details/i)).toBeTruthy();
  });

  it("reveals crypto details on toggle", async () => {
    setup(true);
    const user = userEvent.setup();
    render(<WalletView />);
    await waitFor(() => expect(screen.getByText("$18.60")).toBeTruthy());
    await user.click(screen.getByText(/Show crypto details/i));
    await waitFor(() => expect(screen.getByText(ADDR)).toBeTruthy());
  });

  it("falls back to the crypto-first view when uiDollars is off", async () => {
    setup(false);
    render(<WalletView />);
    // Address shown directly, no dollar hero / toggle.
    await waitFor(() => expect(screen.getByText(ADDR)).toBeTruthy());
    expect(screen.queryByText(/Show crypto details/i)).toBeNull();
    expect(screen.getByText(/Coinbase AgentKit wallet/i)).toBeTruthy();
  });
});
