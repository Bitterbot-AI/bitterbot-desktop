/** One connector: an MCP server the agent can use. */
export type McpServerSpec = {
  /** Short name the owner chose; tools appear as mcp__<name>__<tool>. */
  name: string;
  /** "stdio": a local program. "http": a remote server (Streamable HTTP). */
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  /** Let this connector change things without asking each time. Default false. */
  trustWrites?: boolean;
};

export type McpToolSummary = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
};

export type McpServerStatus = {
  name: string;
  transport: McpServerSpec["transport"];
  enabled: boolean;
  trustWrites: boolean;
  state: "connected" | "connecting" | "error" | "off";
  error?: string;
  tools: Array<{ name: string; readOnly: boolean; description?: string }>;
  connectedAt?: number;
};
