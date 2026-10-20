import { create } from "zustand";

/** A stored spend grant (claims + revocation state) as returned by spendGrant.list. */
export type SpendGrantRow = {
  grant_id: string;
  owner_pubkey: string;
  scope: { allowed_payees: string[]; categories?: string[] };
  allowance: { amount: string; currency: string };
  period_seconds: number;
  per_tx_max?: { amount: string; currency: string };
  iat: number;
  exp: number;
  revokedAt: number | null;
  [key: string]: unknown;
};

/** A pending/resolved escalation request as returned by spendGrant.approvals. */
export type SpendApproval = {
  approvalId: string;
  payee: string;
  amountUsd: number;
  reason: string;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  resolvedAt: number | null;
  grantId: string | null;
  /** Step-up confirmation method recorded on approve: "passkey" | "typed" | null. */
  confirmation?: string | null;
};

type SpendGrantsState = {
  grants: SpendGrantRow[];
  approvals: SpendApproval[];
  /** Whether a2a.payment.consent.grantsRequired is on (escalation active). */
  grantsRequired: boolean;
  /**
   * USD amount at/above which approving an escalation requires a step-up
   * (a2a.payment.escalation.stepUpThresholdUsd). null / <= 0 = disabled.
   */
  stepUpThresholdUsd: number | null;
  loading: boolean;
  error: string | null;
  setGrants: (grants: SpendGrantRow[]) => void;
  setApprovals: (approvals: SpendApproval[]) => void;
  setGrantsRequired: (grantsRequired: boolean) => void;
  setStepUpThresholdUsd: (stepUpThresholdUsd: number | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
};

export const useSpendGrantsStore = create<SpendGrantsState>((set) => ({
  grants: [],
  approvals: [],
  grantsRequired: false,
  stepUpThresholdUsd: null,
  loading: false,
  error: null,
  setGrants: (grants) => set({ grants }),
  setApprovals: (approvals) => set({ approvals }),
  setGrantsRequired: (grantsRequired) => set({ grantsRequired }),
  setStepUpThresholdUsd: (stepUpThresholdUsd) => set({ stepUpThresholdUsd }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
