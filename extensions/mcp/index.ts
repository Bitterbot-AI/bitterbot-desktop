import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";
import {
  emptyPluginConfigSchema,
  setConnectorExecutor,
  setConnectorTools,
} from "bitterbot/plugin-sdk";
import { McpManager } from "./src/manager.js";
import { loadServers, parseServerSpec, saveServers, serversFile } from "./src/store.js";
import { buildAgentTools, listConnectorTools, toToolResult } from "./src/tools.js";
import type { McpServerSpec } from "./src/types.js";

/**
 * Connectors (PLAN-53 D2, D5): an MCP client. Each connected MCP server's
 * tools reach the agent as mcp__<server>__<tool>, behind the same tool policy,
 * deferred loading and review as built-in tools. A tool the server does not
 * declare read-only is treated as a change and waits for the owner.
 */
const plugin = {
  id: "mcp",
  name: "Connectors",
  description: "Connect MCP servers and give their tools to the agent",
  configSchema: emptyPluginConfigSchema(),
  register(api: BitterbotPluginApi) {
    const manager = new McpManager();
    let file: string | null = null;

    // Keep the review layer's list of which connector tools change things.
    const publish = () => {
      const byServer = new Map<
        string,
        Array<[string, ReturnType<typeof listConnectorTools>[number]["info"]]>
      >();
      for (const s of manager.status()) byServer.set(s.name, []);
      for (const entry of listConnectorTools(manager)) {
        byServer.get(entry.info.server)?.push([entry.name, entry.info]);
      }
      for (const [server, list] of byServer) setConnectorTools(server, list);
    };
    manager.onChange(publish);

    setConnectorExecutor(async (toolName, params) => {
      const entry = listConnectorTools(manager).find((e) => e.name === toolName);
      if (!entry) {
        return { ok: false, summary: `the connector for ${toolName} is not connected` };
      }
      const result = toToolResult(
        await manager.call(
          entry.server.name,
          entry.tool.name,
          (params ?? {}) as Record<string, unknown>,
        ),
      );
      const text = result.content
        .map((b) => b.text)
        .join("\n")
        .slice(0, 2000);
      return { ok: result.details.status !== "error", summary: text };
    });

    api.registerService({
      id: "mcp-connectors",
      start: async (ctx) => {
        file = serversFile(ctx.stateDir);
        const servers = await loadServers(file);
        await manager.sync(servers);
        const connected = manager.status().filter((s) => s.state === "connected").length;
        if (servers.length > 0) {
          api.logger.info(`connectors: ${connected} of ${servers.length} connected`);
        }
      },
      stop: async () => {
        await manager.closeAll();
      },
    });

    // Synchronous, per run: whatever is connected right now.
    api.registerTool(() => buildAgentTools(manager));

    const requireFile = () => {
      if (!file) throw new Error("connectors are still starting");
      return file;
    };
    const update = async (fn: (servers: McpServerSpec[]) => McpServerSpec[]) => {
      const f = requireFile();
      const next = fn(await loadServers(f));
      await saveServers(f, next);
      await manager.sync(next);
      return manager.status();
    };
    const fail = (respond: (ok: boolean, p?: unknown, e?: unknown) => void, err: unknown) =>
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: err instanceof Error ? err.message : String(err),
      });

    api.registerGatewayMethod("mcp.list", ({ respond }) => {
      respond(true, { servers: manager.status() });
    });
    api.registerGatewayMethod("mcp.add", async ({ params, respond }) => {
      try {
        const spec = parseServerSpec(params);
        const servers = await update((list) => {
          if (list.some((s) => s.name === spec.name)) {
            throw new Error(`a connector named ${spec.name} already exists`);
          }
          return [...list, spec];
        });
        respond(true, { server: servers.find((s) => s.name === spec.name) });
      } catch (err) {
        fail(respond, err);
      }
    });
    api.registerGatewayMethod("mcp.update", async ({ params, respond }) => {
      try {
        const name = String(params.name ?? "");
        const servers = await update((list) => {
          const existing = list.find((s) => s.name === name);
          if (!existing) throw new Error(`no connector named ${name}`);
          const patch = (params.patch ?? {}) as Record<string, unknown>;
          return list.map((s) =>
            s.name === name ? parseServerSpec({ ...existing, ...patch, name }) : s,
          );
        });
        respond(true, { server: servers.find((s) => s.name === name) });
      } catch (err) {
        fail(respond, err);
      }
    });
    api.registerGatewayMethod("mcp.remove", async ({ params, respond }) => {
      try {
        const name = String(params.name ?? "");
        await update((list) => list.filter((s) => s.name !== name));
        respond(true, { ok: true });
      } catch (err) {
        fail(respond, err);
      }
    });
    api.registerGatewayMethod("mcp.refresh", async ({ params, respond }) => {
      try {
        respond(true, { server: await manager.refresh(String(params.name ?? "")) });
      } catch (err) {
        fail(respond, err);
      }
    });
  },
};

export default plugin;
