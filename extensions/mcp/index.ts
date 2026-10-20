import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";
import {
  emptyPluginConfigSchema,
  setConnectorExecutor,
  setConnectorTools,
} from "bitterbot/plugin-sdk";
import { McpManager } from "./src/manager.js";
import { FileOAuthProvider, oauthFile, stateMatches } from "./src/oauth.js";
import { loadServers, parseServerSpec, saveServers, serversFile } from "./src/store.js";
import { buildAgentTools, listConnectorTools, toToolResult } from "./src/tools.js";
import type { McpServerSpec } from "./src/types.js";

/**
 * Connectors (PLAN-53 D2, D5): an MCP client. Each connected MCP server's
 * tools reach the agent as mcp__<server>__<tool>, behind the same tool policy,
 * deferred loading and review as built-in tools. A tool the server does not
 * declare read-only is treated as a change and waits for the owner.
 */
const CALLBACK_PATH = "/mcp/oauth/callback";

const plugin = {
  id: "mcp",
  name: "Connectors",
  description: "Connect MCP servers and give their tools to the agent",
  configSchema: emptyPluginConfigSchema(),
  register(api: BitterbotPluginApi) {
    let file: string | null = null;
    let stateDir: string | null = null;
    const port = Number(process.env.BITTERBOT_GATEWAY_PORT) || api.config.gateway?.port || 19001;
    const callbackUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const manager = new McpManager(undefined, (spec) => {
      if (!stateDir) throw new Error("connectors are still starting");
      return new FileOAuthProvider(oauthFile(stateDir, spec.name), callbackUrl);
    });

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
        stateDir = ctx.stateDir;
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
    type Respond = Parameters<
      Parameters<BitterbotPluginApi["registerGatewayMethod"]>[1]
    >[0]["respond"];
    const fail = (respond: Respond, err: unknown) =>
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
    api.registerGatewayMethod("mcp.signOut", async ({ params, respond }) => {
      try {
        const name = String(params.name ?? "");
        manager.authOf(name)?.signOut();
        respond(true, { server: await manager.refresh(name) });
      } catch (err) {
        fail(respond, err);
      }
    });

    // The owner's browser comes back here after signing in to a connector.
    // Unauthenticated by design (it is a browser redirect); the one-time
    // state value issued for that sign-in is what identifies it.
    api.registerHttpRoute({
      path: CALLBACK_PATH,
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const page = (status: number, title: string, body: string) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(
            `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`,
          );
        };
        const match = manager
          .status()
          .map((s) => s.name)
          .find((name) => stateMatches(manager.authOf(name)?.savedState(), state));
        const spec = match ? manager.specOf(match) : undefined;
        const provider = match ? manager.authOf(match) : undefined;
        if (!match || !spec?.url || !provider || !code) {
          page(
            400,
            "Sign-in not recognised",
            "This sign-in link is not one Bitterbot started, or it was already used. Start again from the Connectors page.",
          );
          return;
        }
        try {
          const result = await auth(provider, { serverUrl: spec.url, authorizationCode: code });
          if (result !== "AUTHORIZED") throw new Error(`the server answered ${result}`);
          provider.pendingAuthorizationUrl = null;
          await manager.refresh(match);
          page(200, `Connected ${match}`, "You can close this tab and go back to Bitterbot.");
        } catch (err) {
          page(
            502,
            "Sign-in did not finish",
            `The ${match} connector did not accept the sign-in: ${String(err instanceof Error ? err.message : err).replace(/[<>&]/g, "")}`,
          );
        }
      },
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
