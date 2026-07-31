import { create } from "zustand";
import { useGatewayStore } from "./gateway-store";

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
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
  entry?: { modelOverride?: string };
}

interface SessionsListResult {
  sessions?: SessionsListRow[];
  defaults?: { model?: string | null; modelProvider?: string | null };
}

interface ModelsState {
  catalog: ModelCatalogEntry[];
  catalogLoaded: boolean;
  catalogLoading: boolean;
  /** Effective model per chat session key, as last fetched/patched. */
  sessionModels: Record<string, SessionModelInfo>;

  loadCatalog: (opts?: { force?: boolean }) => Promise<void>;
  loadSessionModel: (sessionKey: string) => Promise<void>;
  setSessionModel: (sessionKey: string, modelRef: string | null) => Promise<SessionModelInfo>;
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

export const useModelsStore = create<ModelsState>((set, get) => ({
  catalog: [],
  catalogLoaded: false,
  catalogLoading: false,
  sessionModels: {},

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
      // Older gateways or unresolvable keys: fall back to the raw key.
    }
    try {
      const res = await request<SessionsListResult>("sessions.list", {});
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
            overridden: Boolean(row?.entry?.modelOverride?.trim()),
          },
        },
      }));
    } catch {
      // Central toast covers the failure; leave prior state in place.
    }
  },

  setSessionModel: async (sessionKey, modelRef) => {
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
}));
