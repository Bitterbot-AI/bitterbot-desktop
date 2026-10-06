/**
 * Connector tools in the review queue (PLAN-53 D5).
 *
 * A connector (an MCP server: a calendar, a mailbox, a ticket tracker) can
 * read or change things on the owner's behalf. Each connector tool declares
 * which it does when it is registered. Reads run; writes wait for the owner,
 * unless the owner said that connector may write freely. A tool that does not
 * say counts as a write.
 */

export type ConnectorToolInfo = {
  /** The connector it belongs to, as the owner named it. */
  server: string;
  /** The tool's own name on that server. */
  tool: string;
  /** True only when the server declares the tool read-only. */
  readOnly: boolean;
  /** The owner let this connector change things without asking. */
  trustWrites: boolean;
};

export type ConnectorExecutor = (
  toolName: string,
  params: unknown,
) => Promise<{ ok: boolean; summary: string }>;

const tools = new Map<string, ConnectorToolInfo>();
let executor: ConnectorExecutor | null = null;

/** Replace every registered tool of one connector (on connect or refresh). */
export function setConnectorTools(server: string, list: Array<[string, ConnectorToolInfo]>): void {
  for (const [name, info] of tools) {
    if (info.server === server) tools.delete(name);
  }
  for (const [name, info] of list) {
    tools.set(name, info);
  }
}

export function getConnectorTool(toolName: string): ConnectorToolInfo | undefined {
  return tools.get(toolName);
}

/** How an approved connector write is carried out: installed by the connector plugin. */
export function setConnectorExecutor(fn: ConnectorExecutor | null): void {
  executor = fn;
}

export function getConnectorExecutor(): ConnectorExecutor | null {
  return executor;
}

export function resetConnectorsForTest(): void {
  tools.clear();
  executor = null;
}
