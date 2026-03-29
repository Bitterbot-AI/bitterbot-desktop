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
};

interface WalletState {
  address: string | null;
  network: string | null;
  balances: WalletBalance[];
  transactions: WalletTransaction[];
  config: WalletConfig | null;
  loading: boolean;
  error: string | null;

  setAddress: (address: string, network: string) => void;
  setBalances: (balances: WalletBalance[]) => void;
  setTransactions: (transactions: WalletTransaction[]) => void;
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
  config: null,
  loading: false,
  error: null,

  setAddress: (address, network) => set({ address, network }),
  setBalances: (balances) => set({ balances }),
  setTransactions: (transactions) => set({ transactions }),
  setConfig: (config) => set({ config }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  reset: () =>
    set({
      address: null,
      network: null,
      balances: [],
      transactions: [],
      config: null,
      loading: false,
      error: null,
    }),
}));
