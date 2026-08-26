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

// Capability probes: methods whose FAILURE is a signal the caller interprets
// (e.g. "this is not a management node"), never a user-facing error.
// sessions.resolve: the ModelPicker resolves the chat session key on every
// mount; a brand-new session legitimately has no store entry yet and the
// caller falls back to defaults, so "No session found" is not an error.
const QUIET_PROBE_METHODS = new Set(["management.health", "sessions.resolve"]);

// Version skew is a normal fleet condition: an edge node's UI (Vite, latest)
// can be newer than its gateway binary, so a polled RPC the gateway doesn't
// know yet must degrade silently — one console note, no toast storm.
const unsupportedMethods = new Set<string>();

function dispatchErrorToast(err: GatewayRequestError): void {
  if (QUIET_PROBE_METHODS.has(err.method)) {
    return;
  }
  if (err.message.includes("unknown method")) {
    if (!unsupportedMethods.has(err.method)) {
      unsupportedMethods.add(err.method);
      console.warn(
        `gateway does not implement ${err.method} (older gateway build); ` +
          `the feature stays hidden until the gateway is updated`,
      );
    }
    return;
  }
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

import {
  LS_TOKEN_KEY,
  LS_URL_KEY,
  readStoredGatewayToken as readStoredToken,
  resolveGatewayWsUrl,
} from "../lib/gateway-origin";

// Credential resolution lives in lib/gateway-origin.ts. The build-time
// VITE_GATEWAY_TOKEN define is gone (PLAN-39 Phase 3 / PLAN-37 item 13): baking
// the gateway credential into the bundle made the artifact machine-specific and
// would publish the token to anyone who fetched the JS once the gateway serves it.
/**
 * A token the user previously entered. Null means we have nothing stored; the
 * caller should try the same-origin handoff and then FirstRun.
 */
export function readStoredGatewayToken(): string | null {
  return readStoredToken();
}

/** The gateway WS URL: stored override, dev env var, or derived from the page origin. */
export function readStoredGatewayUrl(): string {
  return resolveGatewayWsUrl();
}

export { persistGatewayCredentials } from "../lib/gateway-origin";

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
  request: <T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ) => Promise<T>;
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

    // No "local-dev-token" fallback: no server ever accepted it, so connecting with
    // it only produced a confusing auth failure instead of prompting for a token.
    const token = tokenOverride?.trim() || readStoredGatewayToken() || "";

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

  request: async <T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> => {
    const client = get().client;
    if (!client) {
      throw new Error("Gateway not connected");
    }
    return client.request<T>(method, params, options);
  },

  subscribe: (listener: EventListener) => {
    const listeners = get().eventListeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
}));
