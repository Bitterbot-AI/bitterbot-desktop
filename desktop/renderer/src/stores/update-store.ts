import { create } from "zustand";

// Mirrors the gateway's UpdateStatusEvent / update.check response spine.
export type UpdateStaleness = {
  behind: number | null;
  threshold: number;
  stale: boolean;
  reason: "git-behind" | "package-version" | "fresh" | "unknown";
};

export type UpdateInfo = {
  version: string;
  installKind: "git" | "package" | "unknown";
  sha: string | null;
  branch: string | null;
  registryLatest: string | null;
  staleness: UpdateStaleness;
  checkedAt: number;
  /** False when the staleness numbers come from a failed `git fetch`. */
  fetchOk?: boolean | null;
  /** Subjects of the commits an update would bring (git installs, capped). */
  pendingCommits?: string[];
  /** Only populated by update.check (the event omits it). */
  dirty?: boolean | null;
};

export type UpdateRunOutcome = {
  status: string;
  reason: string | null;
  restarting: boolean;
};

type UpdateState = {
  info: UpdateInfo | null;
  checking: boolean;
  updating: boolean;
  outcome: UpdateRunOutcome | null;
  /** Local sha the human dismissed the banner for; clears when the node updates. */
  dismissedSha: string | null;
  /**
   * Set true when a successful update.run restarts the gateway; the next
   * disconnect→reconnect triggers a full page reload so the browser picks up
   * any new renderer bundle. Restart/shutdown do NOT set this (no code change).
   */
  reloadAfterReconnect: boolean;
  setInfo: (info: UpdateInfo) => void;
  setChecking: (checking: boolean) => void;
  setUpdating: (updating: boolean) => void;
  setOutcome: (outcome: UpdateRunOutcome | null) => void;
  dismissBanner: () => void;
  /** Reconnect: drop pre-restart data so the UI re-learns the node's state. */
  resetForReconnect: () => void;
  setReloadAfterReconnect: (v: boolean) => void;
};

export const useUpdateStore = create<UpdateState>((set, get) => ({
  info: null,
  checking: false,
  updating: false,
  outcome: null,
  dismissedSha: null,
  reloadAfterReconnect: false,
  setInfo: (info) => set({ info }),
  setChecking: (checking) => set({ checking }),
  setUpdating: (updating) => set({ updating }),
  setOutcome: (outcome) => set({ outcome }),
  dismissBanner: () => set({ dismissedSha: get().info?.sha ?? "unknown" }),
  resetForReconnect: () => set({ info: null, outcome: null, updating: false, checking: false }),
  setReloadAfterReconnect: (v) => set({ reloadAfterReconnect: v }),
}));

/** The banner shows only for a stale node the human has not dismissed at this sha. */
export function shouldShowUpdateBanner(state: {
  info: UpdateInfo | null;
  updating: boolean;
  dismissedSha: string | null;
}): boolean {
  const { info, updating, dismissedSha } = state;
  if (!info || updating) return false;
  if (!info.staleness.stale) return false;
  return dismissedSha !== (info.sha ?? "unknown");
}

/** Shape of the update.check RPC response the UI consumes. */
export type UpdateCheckResponse = {
  ok: boolean;
  version: string;
  channel: string | null;
  check: {
    installKind: "git" | "package" | "unknown";
    git?: {
      sha: string | null;
      branch: string | null;
      behind: number | null;
      dirty: boolean | null;
      fetchOk: boolean | null;
      pendingCommits?: string[];
    };
  };
  registryLatest: string | null;
  staleness: UpdateStaleness;
  checkedAt: number;
};

/** Normalize an update.check response into the store's UpdateInfo. */
export function parseCheckResponse(resp: UpdateCheckResponse): UpdateInfo {
  return {
    version: resp.version,
    installKind: resp.check.installKind,
    sha: resp.check.git?.sha ?? null,
    branch: resp.check.git?.branch ?? null,
    registryLatest: resp.registryLatest ?? null,
    staleness: resp.staleness,
    checkedAt: resp.checkedAt,
    fetchOk: resp.check.git?.fetchOk ?? null,
    dirty: resp.check.git?.dirty ?? null,
    pendingCommits: resp.check.git?.pendingCommits ?? [],
  };
}

/** Normalize an `update` gateway event payload; null when malformed. */
export function parseUpdateEvent(payload: unknown): UpdateInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const staleness = p.staleness as UpdateStaleness | undefined;
  if (!staleness || typeof staleness !== "object") return null;
  return {
    version: typeof p.version === "string" ? p.version : "?",
    installKind: p.installKind === "git" || p.installKind === "package" ? p.installKind : "unknown",
    sha: typeof p.sha === "string" ? p.sha : null,
    branch: typeof p.branch === "string" ? p.branch : null,
    registryLatest: typeof p.registryLatest === "string" ? p.registryLatest : null,
    staleness,
    checkedAt: typeof p.checkedAt === "number" ? p.checkedAt : Date.now(),
    fetchOk: typeof p.fetchOk === "boolean" ? p.fetchOk : null,
  };
}
