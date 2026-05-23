/**
 * PLAN-20 Phase 2: structured record of every interceptor activation.
 *
 * Mirrors HASP's e_t = (s_t, a_orig, ã, c_t, κ_t, Δ_t). The record is
 * persisted to the SQLite memory store (table `intervention_records`,
 * migration v14), Ed25519-signed by the node identity at write time, and
 * later joined with a downstream `OutcomeSignal` patched in by the
 * experience-signal-collector 1-3 turns after the intervention fired.
 *
 * Signing happens lazily via the node identity key already provisioned for
 * skill ingestion and management-node auth. The runner falls back to an
 * unsigned record if no signer is registered (tests, isolated workers).
 */

import type {
  CandidateAction,
  GCCRFSnapshot,
  HormonalSnapshot,
  Intervention,
} from "./interceptor.js";

export interface InterventionRecord {
  readonly id: string;
  readonly ts: number;
  readonly sessionKey: string;
  readonly skill: string;
  readonly interceptorId: string;
  readonly stateSummary: {
    readonly hormonal: HormonalSnapshot;
    readonly gccrf: GCCRFSnapshot;
    readonly channel: string;
  };
  readonly actionOriginal: CandidateAction;
  /** Null when the intervention blocked the action. */
  readonly actionFinal: CandidateAction | null;
  readonly intervention: Intervention;
  readonly metadata: {
    readonly activationLatencyMs: number;
    readonly interventionLatencyMs: number;
  };
  readonly outcomeSignal?: OutcomeSignal;
  readonly sig: {
    readonly ed25519: string;
    readonly pubkeyId: string;
  };
}

export type OutcomeSignal =
  | { tag: "downstream-success"; evidence: string }
  | { tag: "downstream-failure"; evidence: string }
  | { tag: "user-confirmed-block"; evidence: string }
  | { tag: "user-overrode-block"; evidence: string }
  | { tag: "no-signal" };

export type InterventionSigner = (canonicalJson: string) => {
  ed25519: string;
  pubkeyId: string;
};

let registeredSigner: InterventionSigner | null = null;

export function setInterventionSigner(signer: InterventionSigner | null): void {
  registeredSigner = signer;
}

/**
 * Build the canonical JSON that gets signed. Stable key ordering so the
 * signature is deterministic across runs.
 */
function canonicalize(rec: Omit<InterventionRecord, "sig">): string {
  const ordered = {
    id: rec.id,
    ts: rec.ts,
    sessionKey: rec.sessionKey,
    skill: rec.skill,
    interceptorId: rec.interceptorId,
    stateSummary: rec.stateSummary,
    actionOriginal: rec.actionOriginal,
    actionFinal: rec.actionFinal,
    intervention: rec.intervention,
    metadata: rec.metadata,
  };
  return JSON.stringify(ordered);
}

export function signInterventionRecord(rec: Omit<InterventionRecord, "sig">): InterventionRecord {
  if (registeredSigner) {
    const sig = registeredSigner(canonicalize(rec));
    return { ...rec, sig };
  }
  // Unsigned fallback (still has a stable shape so the SQLite write
  // doesn't break). Mark with a sentinel pubkeyId so consumers can tell.
  return {
    ...rec,
    sig: { ed25519: "", pubkeyId: "unsigned-local" },
  };
}

export interface InterventionStore {
  insert(rec: InterventionRecord): void;
  attachOutcome(id: string, signal: OutcomeSignal): void;
  recent(args: { limit?: number; sessionKey?: string }): InterventionRecord[];
}

let registeredStore: InterventionStore | null = null;

export function setInterventionStore(store: InterventionStore | null): void {
  registeredStore = store;
}

export function getInterventionStore(): InterventionStore | null {
  return registeredStore;
}

export const __testing = {
  canonicalize,
};
