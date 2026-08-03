import { create } from "zustand";
import { useGatewayStore } from "./gateway-store";

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  /** Selectable under the node's model policy. Absent = allowed (old gateway). */
  allowed?: boolean;
}

export interface SessionModelInfo {
  /** Effective model id for the session (override or default). */
  model: string;
  provider: string;
  /** True when the session carries a stored model override. */
  overridden: boolean;
}

interface SessionsListRow {
  key: string;
  model?: string;
  modelProvider?: string;
  modelOverridden?: boolean;
}

interface SessionsListResult {
  sessions?: SessionsListRow[];
  defaults?: { model?: string | null; modelProvider?: string | null };
}

export interface ProviderProfileStatus {
  profileId: string;
  type: "api_key" | "token" | "oauth";
  email?: string;
  inCooldown: boolean;
  disabledUntil?: number;
  errorCount?: number;
  lastUsed?: number;
}

export interface ProviderAuthStatus {
  provider: string;
  profiles: ProviderProfileStatus[];
  envPresent: boolean;
  envSource?: string;
  configKeyPresent: boolean;
  winningSource: string | null;
}

export interface AuthProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
  unsupported?: boolean;
}

interface ModelsState {
  catalog: ModelCatalogEntry[];
  catalogLoaded: boolean;
  catalogLoading: boolean;
  /** Effective model per chat session key, as last fetched/patched. */
  sessionModels: Record<string, SessionModelInfo>;
  /** Per-provider credential status from models.auth.list. */
  authStatus: ProviderAuthStatus[];
  authLoading: boolean;
  /** The node's default model ("provider/model") from sessions.list defaults. */
  defaultModel: string | null;

  loadCatalog: (opts?: { force?: boolean }) => Promise<void>;
  loadSessionModel: (sessionKey: string) => Promise<void>;
  setSessionModel: (sessionKey: string, modelRef: string | null) => Promise<SessionModelInfo>;
  loadAuthStatus: () => Promise<void>;
  loadDefaultModel: () => Promise<void>;
  setDefaultModel: (modelRef: string) => Promise<void>;
  testKey: (params: {
    provider: string;
    apiKey?: string;
    profileId?: string;
    baseUrl?: string;
  }) => Promise<AuthProbeResult>;
  saveKey: (params: {
    provider: string;
    name?: string;
    credentialType?: "api_key" | "token";
    value: string;
  }) => Promise<{ profileId: string }>;
  deleteProfile: (profileId: string) => Promise<void>;
}

/**
 * Group catalog entries by provider, preserving catalog order within
 * each provider. Returned as [provider, entries] pairs sorted by name.
 */
export function groupCatalogByProvider(
  catalog: ModelCatalogEntry[],
): Array<[string, ModelCatalogEntry[]]> {
  const groups = new Map<string, ModelCatalogEntry[]>();
  for (const entry of catalog) {
    const list = groups.get(entry.provider);
    if (list) {
      list.push(entry);
    } else {
      groups.set(entry.provider, [entry]);
    }
  }
  return [...groups.entries()].toSorted((a, b) => a[0].localeCompare(b[0]));
}

// Monotonic sequence per session key: a slow loadSessionModel (two RPCs)
// must never overwrite the result of a later load or a sessions.patch.
const sessionModelSeq: Record<string, number> = {};

export const useModelsStore = create<ModelsState>((set, get) => ({
  catalog: [],
  catalogLoaded: false,
  catalogLoading: false,
  sessionModels: {},
  authStatus: [],
  authLoading: false,
  defaultModel: null,

  loadCatalog: async (opts) => {
    const { catalogLoaded, catalogLoading } = get();
    if (catalogLoading || (catalogLoaded && !opts?.force)) return;
    set({ catalogLoading: true });
    try {
      const request = useGatewayStore.getState().request;
      const res = await request<{ models?: ModelCatalogEntry[] }>("models.list", {});
      set({
        catalog: Array.isArray(res?.models) ? res.models : [],
        catalogLoaded: true,
        catalogLoading: false,
      });
    } catch {
      // Error toast is dispatched centrally by gateway-store; keep prior
      // catalog (possibly empty) and allow a later retry.
      set({ catalogLoading: false });
    }
  },

  loadSessionModel: async (sessionKey) => {
    const seq = (sessionModelSeq[sessionKey] = (sessionModelSeq[sessionKey] ?? 0) + 1);
    const request = useGatewayStore.getState().request;
    // Resolve the UI's session key (often an alias like "default") to the
    // canonical store key so we can match the sessions.list row.
    let canonicalKey = sessionKey;
    try {
      const resolved = await request<{ ok?: boolean; key?: string }>("sessions.resolve", {
        key: sessionKey,
      });
      if (resolved?.key) canonicalKey = resolved.key;
    } catch {
      // Older gateways, or a brand-new session with no store entry yet:
      // fall back to the raw key (the defaults below still apply).
    }
    try {
      const res = await request<SessionsListResult>("sessions.list", {});
      if (sessionModelSeq[sessionKey] !== seq) {
        // A later load or a sessions.patch won while we were in flight.
        return;
      }
      const row = res?.sessions?.find((s) => s.key === canonicalKey);
      const model = row?.model ?? res?.defaults?.model ?? "";
      const provider = row?.modelProvider ?? res?.defaults?.modelProvider ?? "";
      if (!model) return;
      set((state) => ({
        sessionModels: {
          ...state.sessionModels,
          [sessionKey]: {
            model,
            provider,
            overridden: row?.modelOverridden === true,
          },
        },
      }));
    } catch {
      // Central toast covers the failure; leave prior state in place.
    }
  },

  setSessionModel: async (sessionKey, modelRef) => {
    // Invalidate any in-flight loadSessionModel so its stale response can't
    // overwrite the patch result we're about to write.
    sessionModelSeq[sessionKey] = (sessionModelSeq[sessionKey] ?? 0) + 1;
    const request = useGatewayStore.getState().request;
    const res = await request<{
      ok?: boolean;
      entry?: { modelOverride?: string };
      resolved?: { model?: string; modelProvider?: string };
    }>("sessions.patch", { key: sessionKey, model: modelRef });
    const info: SessionModelInfo = {
      model: res?.resolved?.model ?? "",
      provider: res?.resolved?.modelProvider ?? "",
      overridden: Boolean(res?.entry?.modelOverride?.trim()),
    };
    if (info.model) {
      set((state) => ({
        sessionModels: { ...state.sessionModels, [sessionKey]: info },
      }));
    }
    return info;
  },

  loadAuthStatus: async () => {
    if (get().authLoading) return;
    set({ authLoading: true });
    try {
      const request = useGatewayStore.getState().request;
      const res = await request<{ providers?: ProviderAuthStatus[] }>("models.auth.list", {});
      set({ authStatus: Array.isArray(res?.providers) ? res.providers : [], authLoading: false });
    } catch {
      set({ authLoading: false });
    }
  },

  loadDefaultModel: async () => {
    try {
      const request = useGatewayStore.getState().request;
      const res = await request<{
        defaults?: { model?: string | null; modelProvider?: string | null };
      }>("sessions.list", {});
      const model = res?.defaults?.model;
      const provider = res?.defaults?.modelProvider;
      set({ defaultModel: model ? (provider ? `${provider}/${model}` : model) : null });
    } catch {
      // Central toast covers failures.
    }
  },

  setDefaultModel: async (modelRef) => {
    const request = useGatewayStore.getState().request;
    const res = await request<{ ok?: boolean; model?: string }>("models.setDefault", {
      model: modelRef,
    });
    if (res?.model) {
      set({ defaultModel: res.model });
    }
    // The allowlist may have gained an entry; keep the catalog view fresh.
    await get().loadDefaultModel();
  },

  testKey: async (params) => {
    const request = useGatewayStore.getState().request;
    const res = await request<{ result?: AuthProbeResult }>("models.auth.test", params);
    return res?.result ?? { ok: false, error: "empty probe response" };
  },

  saveKey: async (params) => {
    const request = useGatewayStore.getState().request;
    const res = await request<{ ok?: boolean; profileId?: string }>("models.auth.set", params);
    // New keys can add providers/models: refresh both the auth panel and the
    // catalog (server already busted its cache; refresh:true keeps the UI in
    // lockstep even if that failed).
    await Promise.all([
      get().loadAuthStatus(),
      (async () => {
        try {
          const fresh = await request<{ models?: ModelCatalogEntry[] }>("models.list", {
            refresh: true,
          });
          if (Array.isArray(fresh?.models)) {
            set({ catalog: fresh.models, catalogLoaded: true });
          }
        } catch {
          // Non-fatal; the stale catalog stays until the next open.
        }
      })(),
    ]);
    return { profileId: res?.profileId ?? "" };
  },

  deleteProfile: async (profileId) => {
    const request = useGatewayStore.getState().request;
    await request("models.auth.delete", { profileId });
    await get().loadAuthStatus();
  },
}));
