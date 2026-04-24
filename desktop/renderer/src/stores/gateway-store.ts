import { toast } from "sonner";
import { create } from "zustand";
import {
  GatewayClient,
  type GatewayEventFrame,
  type GatewayHelloOk,
  type GatewayRequestError,
} from "../lib/gateway-client";

// Rapid-fire errors (same method + code within this window) collapse into
// a single toast to avoid spamming the user when a whole view re-issues
// failing requests. 2s is long enough to dedupe a React re-render storm,
// short enough that a genuinely recurring failure still surfaces.
const TOAST_DEDUPE_WINDOW_MS = 2000;
const recentErrorKeys = new Map<string, number>();

function dispatchErrorToast(err: GatewayRequestError): void {
  const key = `${err.kind}:${err.method}:${err.code ?? ""}`;
  const now = Date.now();
  const lastAt = recentErrorKeys.get(key);
  if (lastAt !== undefined && now - lastAt < TOAST_DEDUPE_WINDOW_MS) {
    return;
  }
  recentErrorKeys.set(key, now);
  // Sweep stale keys opportunistically so the map doesn't grow unbounded
  // in long-lived sessions. Cheap linear pass; there are rarely many.
  for (const [k, ts] of recentErrorKeys) {
    if (now - ts > TOAST_DEDUPE_WINDOW_MS * 4) {
      recentErrorKeys.delete(k);
    }
  }

  const title =
    err.kind === "timeout"
      ? "Request timed out"
      : err.kind === "disconnect"
        ? "Gateway disconnected"
        : "Request failed";
  const description =
    err.kind === "timeout"
      ? `${err.method} didn't respond in time`
      : err.code
        ? `${err.method}: ${err.message} (${err.code})`
        : `${err.method}: ${err.message}`;
  toast.error(title, { description });
}

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
    // Idempotent: if we already have a live client pointed at the same
    // URL and no explicit token override is being tested, do nothing.
    // React StrictMode double-invokes the mount effect in dev, and the
    // previous behavior (unconditionally stop() on re-entry) would kill
    // the first WebSocket mid-handshake on every page load. Symptom was
    // every RPC timing out at 30s because no WS ever completed.
    if (existing && !tokenOverride && existing.url === url) {
      return;
    }
    if (existing) {
      existing.stop();
    }

    set({ status: "connecting", error: null });

    const token = tokenOverride?.trim() || readStoredGatewayToken() || "local-dev-token";

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
      onRequestError: (err) => {
        // One central place for all RPC failure UX. Individual callers
        // still see the rejection and can override, but silent failures
        // are gone — every `ok: false` / timeout / disconnect lands here.
        dispatchErrorToast(err);
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
