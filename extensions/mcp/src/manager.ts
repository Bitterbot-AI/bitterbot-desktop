/**
 * Holds the connections to MCP servers and their tool lists (PLAN-53 D2).
 *
 * The agent's tool list is built synchronously at the start of every run, so
 * tools cannot be discovered then. They are discovered here, on start and
 * whenever a server is added or refreshed, and kept for the tool factory.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSpec, McpServerStatus, McpToolSummary } from "./types.js";

type Connection = {
  spec: McpServerSpec;
  client: Client | null;
  tools: McpToolSummary[];
  state: McpServerStatus["state"];
  error?: string;
  connectedAt?: number;
};

export type McpClientFactory = (
  spec: McpServerSpec,
) => Promise<Pick<Client, "listTools" | "callTool" | "close">>;

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

export const defaultClientFactory: McpClientFactory = async (spec) => {
  const client = new Client({ name: "bitterbot", version: "1.0.0" });
  const transport =
    spec.transport === "stdio"
      ? new StdioClientTransport({
          command: spec.command ?? "",
          args: spec.args ?? [],
          env: { ...(process.env as Record<string, string>), ...spec.env },
          stderr: "ignore",
        })
      : new StreamableHTTPClientTransport(new URL(spec.url ?? ""), {
          requestInit: spec.headers ? { headers: spec.headers } : undefined,
        });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return client;
};

function summarize(tool: {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}): McpToolSummary {
  const schema =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {} };
  return {
    name: tool.name,
    description: tool.description,
    // Only an explicit read-only declaration counts as read-only.
    readOnly: tool.annotations?.readOnlyHint === true,
    inputSchema: { type: "object", properties: {}, ...schema },
  };
}

export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly factory: McpClientFactory = defaultClientFactory) {}

  /** Called after any change to which tools exist. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // a listener's problem is not the manager's
      }
    }
  }

  /** Make the set of servers match `specs`, connecting what is new or changed. */
  async sync(specs: McpServerSpec[]): Promise<void> {
    const wanted = new Map(specs.map((s) => [s.name, s]));
    for (const [name, conn] of this.connections) {
      const next = wanted.get(name);
      if (!next || JSON.stringify(next) !== JSON.stringify(conn.spec)) {
        await this.disconnect(name);
      }
    }
    await Promise.all(
      specs.filter((s) => !this.connections.has(s.name)).map((s) => this.connect(s)),
    );
    this.changed();
  }

  async connect(spec: McpServerSpec): Promise<void> {
    const conn: Connection = {
      spec,
      client: null,
      tools: [],
      state: spec.enabled ? "connecting" : "off",
    };
    this.connections.set(spec.name, conn);
    if (!spec.enabled) return;
    try {
      conn.client = (await this.factory(spec)) as Client;
      const listed = await conn.client.listTools();
      conn.tools = (listed.tools ?? []).map(summarize);
      conn.state = "connected";
      conn.connectedAt = Date.now();
      conn.error = undefined;
    } catch (err) {
      conn.state = "error";
      conn.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      await conn.client?.close().catch(() => {});
      conn.client = null;
    }
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    this.connections.delete(name);
    await conn?.client?.close().catch(() => {});
  }

  async refresh(name: string): Promise<McpServerStatus | undefined> {
    const conn = this.connections.get(name);
    if (!conn) return undefined;
    await this.disconnect(name);
    await this.connect(conn.spec);
    this.changed();
    return this.status().find((s) => s.name === name);
  }

  status(): McpServerStatus[] {
    return [...this.connections.values()].map((c) => ({
      name: c.spec.name,
      transport: c.spec.transport,
      enabled: c.spec.enabled,
      trustWrites: c.spec.trustWrites === true,
      state: c.state,
      ...(c.error ? { error: c.error } : {}),
      ...(c.connectedAt ? { connectedAt: c.connectedAt } : {}),
      tools: c.tools.map((t) => ({
        name: t.name,
        readOnly: t.readOnly,
        description: t.description,
      })),
    }));
  }

  /** Connected servers and their tools, for building agent tools. */
  available(): Array<{ spec: McpServerSpec; tools: McpToolSummary[] }> {
    return [...this.connections.values()]
      .filter((c) => c.state === "connected")
      .map((c) => ({ spec: c.spec, tools: c.tools }));
  }

  async call(server: string, tool: string, args: Record<string, unknown>) {
    const conn = this.connections.get(server);
    if (!conn || conn.state !== "connected" || !conn.client) {
      // One attempt to come back, e.g. a local server that exited.
      if (conn && conn.spec.enabled) {
        await this.refresh(server);
      }
    }
    const live = this.connections.get(server);
    if (!live?.client || live.state !== "connected") {
      throw new Error(
        `The ${server} connector is not connected${live?.error ? `: ${live.error}` : ""}.`,
      );
    }
    return await live.client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((n) => this.disconnect(n)));
  }
}
