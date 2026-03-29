import { create } from "zustand";
import {
  GatewayClient,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "../lib/gateway-client";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

type EventListener = (evt: GatewayEventFrame) => void;

interface GatewayState {
  status: ConnectionStatus;
  hello: GatewayHelloOk | null;
  error: string | null;
  client: GatewayClient | null;
  eventListeners: Set<EventListener>;

  connect: (url: string) => void;
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

  connect: (url: string) => {
    const existing = get().client;
    if (existing) {
      existing.stop();
    }

    set({ status: "connecting", error: null });

    const client = new GatewayClient({
      url,
      token: (import.meta.env.VITE_GATEWAY_TOKEN ?? "local-dev-token").trim(),
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
