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

/**
 * Kept on a process-wide symbol, not in module scope. Extensions load the
 * plugin SDK from its own bundle (dist/plugin-sdk), so a module-level map
 * there and the one the review stage reads in the gateway bundle were two
 * different maps: the connector's "this tool changes things" never reached
 * the approval check, and connector writes ran unreviewed.
 */
type ConnectorState = { tools: Map<string, ConnectorToolInfo>; executor: ConnectorExecutor | null };
const STATE_KEY = Symbol.for("bitterbot.connectorReviewState");

function state(): ConnectorState {
  const g = globalThis as unknown as Record<symbol, ConnectorState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = { tools: new Map(), executor: null };
    g[STATE_KEY] = s;
  }
  return s;
}

/** Replace every registered tool of one connector (on connect or refresh). */
export function setConnectorTools(server: string, list: Array<[string, ConnectorToolInfo]>): void {
  const { tools } = state();
  for (const [name, info] of tools) {
    if (info.server === server) tools.delete(name);
  }
  for (const [name, info] of list) {
    tools.set(name, info);
  }
}

export function getConnectorTool(toolName: string): ConnectorToolInfo | undefined {
  return state().tools.get(toolName);
}

/** How an approved connector write is carried out: installed by the connector plugin. */
export function setConnectorExecutor(fn: ConnectorExecutor | null): void {
  state().executor = fn;
}

export function getConnectorExecutor(): ConnectorExecutor | null {
  return state().executor;
}

export function resetConnectorsForTest(): void {
  state().tools.clear();
  state().executor = null;
}
