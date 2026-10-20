import type { ConnectorToolInfo } from "bitterbot/plugin-sdk";
import type { McpManager } from "./manager.js";
import type { McpServerSpec, McpToolSummary } from "./types.js";

/** Tool names must be short and plain for every model provider. */
export function agentToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const name = `mcp__${clean(server)}__${clean(tool)}`;
  return name.length <= 64 ? name : name.slice(0, 64);
}

type TextBlock = { type: "text"; text: string };

/** An MCP tool result as an agent tool result: text kept, other content described. */
export function toToolResult(result: unknown): {
  content: TextBlock[];
  details: Record<string, unknown>;
} {
  const r = (result ?? {}) as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  const blocks: TextBlock[] = [];
  for (const item of Array.isArray(r.content) ? r.content : []) {
    const block = item as {
      type?: string;
      text?: string;
      mimeType?: string;
      resource?: { uri?: string; text?: string };
    };
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "resource" && block.resource) {
      blocks.push({
        type: "text",
        text: block.resource.text ?? `[resource ${block.resource.uri ?? ""}]`,
      });
    } else if (block.type) {
      blocks.push({
        type: "text",
        text: `[${block.type}${block.mimeType ? ` ${block.mimeType}` : ""} not shown]`,
      });
    }
  }
  if (blocks.length === 0 && r.structuredContent !== undefined) {
    blocks.push({ type: "text", text: JSON.stringify(r.structuredContent).slice(0, 50_000) });
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: r.isError ? "The tool reported an error." : "Done." });
  }
  return {
    content: blocks,
    details: {
      ...(r.isError
        ? {
            status: "error",
            error: blocks
              .map((b) => b.text)
              .join("\n")
              .slice(0, 500),
          }
        : {}),
    },
  };
}

export type ConnectorToolEntry = {
  name: string;
  info: ConnectorToolInfo;
  server: McpServerSpec;
  tool: McpToolSummary;
};

export function listConnectorTools(manager: McpManager): ConnectorToolEntry[] {
  const out: ConnectorToolEntry[] = [];
  for (const { spec, tools } of manager.available()) {
    for (const tool of tools) {
      out.push({
        name: agentToolName(spec.name, tool.name),
        info: {
          server: spec.name,
          tool: tool.name,
          readOnly: tool.readOnly,
          trustWrites: spec.trustWrites === true,
        },
        server: spec,
        tool,
      });
    }
  }
  return out;
}

export function buildAgentTools(manager: McpManager) {
  return listConnectorTools(manager).map((entry) => ({
    name: entry.name,
    label: `${entry.server.name}: ${entry.tool.name}`,
    description: `[${entry.server.name} connector${entry.tool.readOnly ? ", read-only" : ""}] ${
      entry.tool.description ?? entry.tool.name
    }`.slice(0, 1024),
    parameters: entry.tool.inputSchema as never,
    execute: async (_id: string, params: unknown) =>
      toToolResult(
        await manager.call(
          entry.server.name,
          entry.tool.name,
          (params ?? {}) as Record<string, unknown>,
        ),
      ),
  }));
}
