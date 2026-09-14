import { create } from "zustand";

export type WalletBalance = {
  token: string;
  balance: string;
  usdValue?: string;
};

export type WalletTransaction = {
  txHash: string;
  type: string;
  amount: string;
  token: string;
  timestamp: number;
};

export type WalletConfig = {
  enabled: boolean;
  network: string;
  sessionSpendCapUsd: number;
  perTransactionCapUsd: number;
  dailySpendLimitUsd: number;
  x402Enabled: boolean;
  x402MaxPerRequestUsd: number;
  stripeOnrampEnabled: boolean;
  /** PLAN-49 Phase 1: present the wallet in dollars + plain-English ledger. */
  uiDollars?: boolean;
  /** PLAN-49 Phase 2: in-app funding on the consent rail is enabled. */
  onrampEnabled?: boolean;
  /** PLAN-49 Phase 2: hard monthly fiat funding ceiling, if set. */
  fundingMonthlyCeilingUsd?: number;
};

/** PLAN-49 Phase 1: dollar-denominated read model (from wallet.getMoneyView). */
export type LedgerEntry = {
  kind: "funded" | "spent" | "earned" | "withdrawn";
  amountUsd: number;
  at: number;
  counterparty?: string;
  ref?: string;
  feeUsd?: number;
  deltaUsd: number;
  description: string;
};

export type MoneyView = {
  balanceUsd: number;
  currency: "USD";
  entries: LedgerEntry[];
  totals: {
    fundedUsd: number;
    spentUsd: number;
    earnedUsd: number;
    withdrawnUsd: number;
    feesUsd: number;
  };
  note?: string;
};

interface WalletState {
  address: string | null;
  network: string | null;
  balances: WalletBalance[];
  transactions: WalletTransaction[];
  moneyView: MoneyView | null;
  config: WalletConfig | null;
  loading: boolean;
  error: string | null;

  setAddress: (address: string, network: string) => void;
  setBalances: (balances: WalletBalance[]) => void;
  setTransactions: (transactions: WalletTransaction[]) => void;
  setMoneyView: (moneyView: MoneyView | null) => void;
  setConfig: (config: WalletConfig) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useWalletStore = create<WalletState>((set) => ({
  address: null,
  network: null,
  balances: [],
  transactions: [],
  moneyView: null,
  config: null,
  loading: false,
  error: null,

  setAddress: (address, network) => set({ address, network }),
  setBalances: (balances) => set({ balances }),
  setTransactions: (transactions) => set({ transactions }),
  setMoneyView: (moneyView) => set({ moneyView }),
  setConfig: (config) => set({ config }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  reset: () =>
    set({
      address: null,
      network: null,
      balances: [],
      transactions: [],
      moneyView: null,
      config: null,
      loading: false,
      error: null,
    }),
}));
