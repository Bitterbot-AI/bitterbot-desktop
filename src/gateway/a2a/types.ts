/**
 * A2A Protocol v1.0.0 type definitions.
 *
 * Reference: https://a2a-protocol.org/latest/specification/
 * Proto:     https://github.com/a2aproject/A2A/blob/main/spec/a2a.proto
 */

// ---------------------------------------------------------------------------
// Agent Card (discovery)
// ---------------------------------------------------------------------------

export type A2aAgentCard = {
  name: string;
  description: string;
  url: string;
  version: string;
  protocol: string;
  capabilities: A2aCapabilities;
  authentication?: A2aAuthentication;
  skills: A2aSkill[];
  extensions?: Record<string, unknown>;
};

export type A2aCapabilities = {
  streaming: boolean;
  pushNotifications: boolean;
  stateTransitionHistory: boolean;
};

export type A2aAuthentication = {
  schemes: string[];
};

export type A2aSkill = {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 wire format
// ---------------------------------------------------------------------------

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: string | number;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  result?: unknown;
  error?: JsonRpcError;
  id: string | number | null;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

// ---------------------------------------------------------------------------
// A2A Task lifecycle
// ---------------------------------------------------------------------------

export type A2aTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export type A2aTask = {
  id: string;
  contextId?: string;
  status: A2aTaskStatus;
  history?: A2aMessage[];
  artifacts?: A2aArtifact[];
  metadata?: Record<string, unknown>;
};

export type A2aTaskStatus = {
  state: A2aTaskState;
  message?: A2aMessage;
  timestamp: string;
};

// ---------------------------------------------------------------------------
// Messages and parts
// ---------------------------------------------------------------------------

export type A2aMessage = {
  role: "user" | "agent";
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
};

export type A2aPart = A2aTextPart | A2aFilePart | A2aDataPart;

export type A2aTextPart = {
  type: "text";
  text: string;
};

export type A2aFilePart = {
  type: "file";
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string;
    uri?: string;
  };
};

export type A2aDataPart = {
  type: "data";
  data: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export type A2aArtifact = {
  name?: string;
  description?: string;
  parts: A2aPart[];
  index?: number;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// SSE streaming events
// ---------------------------------------------------------------------------

export type A2aTaskStatusUpdateEvent = {
  type: "status";
  taskId: string;
  contextId?: string;
  status: A2aTaskStatus;
  final: boolean;
};

export type A2aTaskArtifactUpdateEvent = {
  type: "artifact";
  taskId: string;
  contextId?: string;
  artifact: A2aArtifact;
};

export type A2aStreamEvent = A2aTaskStatusUpdateEvent | A2aTaskArtifactUpdateEvent;

// ---------------------------------------------------------------------------
// Method params
// ---------------------------------------------------------------------------

export type MessageSendParams = {
  message: A2aMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    blocking?: boolean;
  };
  metadata?: Record<string, unknown>;
};

export type TaskGetParams = {
  id: string;
  historyLength?: number;
};

export type TaskListParams = {
  contextId?: string;
  status?: A2aTaskState;
  limit?: number;
  offset?: number;
};

export type TaskCancelParams = {
  id: string;
};

// ---------------------------------------------------------------------------
// A2A error codes (JSON-RPC standard + A2A extensions)
// ---------------------------------------------------------------------------

export const A2aErrorCodes = {
  // JSON-RPC standard
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // A2A extensions
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  CONTENT_TYPE_NOT_SUPPORTED: -32003,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32004,
  UNAUTHORIZED: -32005,
  PAYMENT_REQUIRED: -32006,
} as const;
