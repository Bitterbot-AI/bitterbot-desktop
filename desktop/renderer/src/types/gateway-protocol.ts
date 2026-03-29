/**
 * Gateway protocol types — shared type definitions for the
 * WebSocket RPC protocol between renderer and gateway.
 */

// Re-export from the client library
export type {
  GatewayEventFrame,
  GatewayResponseFrame,
  GatewayHelloOk,
  GatewayClientOptions,
} from "../lib/gateway-client";

// Gateway snapshot shape (returned in hello-ok)
export interface GatewaySnapshot {
  version?: string;
  channels?: Record<
    string,
    {
      enabled: boolean;
      connected: boolean;
      label?: string;
    }
  >;
  health?: {
    status: string;
    uptime: number;
  };
  skills?: Record<string, { enabled: boolean }>;
  cron?: { jobs: number; running: number };
  nodes?: { count: number };
}

// Chat message types
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatSendParams {
  message: string;
  sessionKey?: string;
  attachments?: Array<{
    type: string;
    data: string;
    name?: string;
  }>;
}

// Channel types
export interface ChannelStatus {
  id: string;
  label: string;
  enabled: boolean;
  connected: boolean;
  error?: string;
}

// Session types
export interface Session {
  key: string;
  channelId: string;
  lastActivity: number;
  metadata?: Record<string, unknown>;
}
