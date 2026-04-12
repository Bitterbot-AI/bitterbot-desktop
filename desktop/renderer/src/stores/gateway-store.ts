import { create } from "zustand";
import {
  GatewayClient,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "../lib/gateway-client";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

type EventListener = (evt: GatewayEventFrame) => void;

// localStorage keys used by the FirstRun flow. A runtime-entered token
// takes precedence over the build-time VITE_GATEWAY_TOKEN env var so
// users who skip the CLI wizard can still get connected via the UI.
const LS_TOKEN_KEY = "bitterbot-gateway-token";
const LS_URL_KEY = "bitterbot-gateway-url";

/**
 * Read the gateway token in priority order:
 *   1. localStorage (runtime-persisted from FirstRun)
 *   2. VITE_GATEWAY_TOKEN env var (build-time, set by desktop/.env)
 * Returns null if neither is set — the UI uses this to decide
 * whether to render <FirstRun> or <AppShell> on boot.
 */
export function readStoredGatewayToken(): string | null {
  try {
    const stored = localStorage.getItem(LS_TOKEN_KEY);
    if (stored && stored.trim().length > 0) return stored.trim();
  } catch {
    // localStorage can be unavailable in non-browser contexts or
    // private-mode browsers with restrictive storage. Fall through.
  }
  const envToken = import.meta.env.VITE_GATEWAY_TOKEN;
  if (typeof envToken === "string" && envToken.trim().length > 0) {
    return envToken.trim();
  }
  return null;
}

export function readStoredGatewayUrl(): string {
  try {
    const stored = localStorage.getItem(LS_URL_KEY);
    if (stored && stored.trim().length > 0) return stored.trim();
  } catch {}
  return import.meta.env.VITE_GATEWAY_URL ?? "ws://127.0.0.1:19001";
}

export function persistGatewayCredentials(params: { url: string; token: string }): void {
  try {
    localStorage.setItem(LS_URL_KEY, params.url);
    localStorage.setItem(LS_TOKEN_KEY, params.token);
  } catch {
    // Non-fatal. If localStorage is blocked the user will have to
    // re-enter next session, which is fine.
  }
}

export function clearStoredGatewayCredentials(): void {
  try {
    localStorage.removeItem(LS_URL_KEY);
    localStorage.removeItem(LS_TOKEN_KEY);
  } catch {}
}

interface GatewayState {
  status: ConnectionStatus;
  hello: GatewayHelloOk | null;
  error: string | null;
  client: GatewayClient | null;
  eventListeners: Set<EventListener>;

  /**
   * Start (or replace) the gateway WebSocket connection.
   * Pass `tokenOverride` to force a specific token — used by the
   * FirstRun flow to test user-entered credentials before persisting.
   */
  connect: (url: string, tokenOverride?: string) => void;
  disconnect: () => void;
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  subscribe: (listener: EventListener) => () => void;
}

export const useGatewayStore = create<GatewayState>((set, get) => ({
  status: "disconnected",
  hello: null,
  error: null,
  client: null,
  eventListeners: new Set(),

  connect: (url: string, tokenOverride?: string) => {
    const existing = get().client;
    if (existing) {
      existing.stop();
    }

    set({ status: "connecting", error: null });

    const token =
      tokenOverride?.trim() || readStoredGatewayToken() || "local-dev-token";

    const client = new GatewayClient({
      url,
      token,
      clientName: import.meta.env.VITE_GATEWAY_CLIENT_NAME ?? "bitterbot-control-ui",
      onHello: (hello) => {
        set({ status: "connected", hello, error: null });
      },
      onEvent: (evt) => {
        const listeners = get().eventListeners;
        for (const listener of listeners) {
          try {
            listener(evt);
          } catch (err) {
            console.error("[gateway-store] event listener error:", err);
          }
        }
      },
      onClose: ({ code, reason }) => {
        // Only set disconnected if we aren't already reconnecting
        set((s) => ({
          status: s.status === "connected" ? "connecting" : s.status,
          error: reason || `Connection closed (${code})`,
        }));
      },
    });

    client.start();
    set({ client });
  },

  disconnect: () => {
    const client = get().client;
    if (client) {
      client.stop();
    }
    set({ client: null, status: "disconnected", hello: null, error: null });
  },

  request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
    const client = get().client;
    if (!client) {
      throw new Error("Gateway not connected");
    }
    return client.request<T>(method, params);
  },

  subscribe: (listener: EventListener) => {
    const listeners = get().eventListeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
}));
