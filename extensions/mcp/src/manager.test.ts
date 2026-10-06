import { describe, expect, it, vi } from "vitest";
import { McpManager, type McpClientFactory } from "./manager.js";
import { parseServerSpec } from "./store.js";
import { agentToolName, buildAgentTools, listConnectorTools, toToolResult } from "./tools.js";
import type { McpServerSpec } from "./types.js";

const spec = (name: string, extra: Partial<McpServerSpec> = {}): McpServerSpec => ({
  name,
  transport: "http",
  url: "https://mcp.example/" + name,
  enabled: true,
  ...extra,
});

function fakeFactory(
  tools: Record<string, Array<{ name: string; readOnly?: boolean }>>,
  failing = new Set<string>(),
) {
  const calls: Array<{ server: string; name: string; args: unknown }> = [];
  const factory: McpClientFactory = async (s) => {
    if (failing.has(s.name)) throw new Error("connection refused");
    return {
      listTools: async () => ({
        tools: (tools[s.name] ?? []).map((t) => ({
          name: t.name,
          description: `${t.name} on ${s.name}`,
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        })),
      }),
      callTool: async ({ name, arguments: args }: { name: string; arguments?: unknown }) => {
        calls.push({ server: s.name, name, args });
        return { content: [{ type: "text", text: `${name} ok` }] };
      },
      close: vi.fn(async () => {}),
    } as never;
  };
  return { factory, calls };
}

describe("McpManager", () => {
  it("connects servers, lists their tools, and reports a server that failed", async () => {
    const { factory } = fakeFactory(
      { cal: [{ name: "list_events", readOnly: true }, { name: "create_event" }] },
      new Set(["mail"]),
    );
    const m = new McpManager(factory);

    await m.sync([spec("cal"), spec("mail"), spec("off", { enabled: false })]);

    const byName = Object.fromEntries(m.status().map((s) => [s.name, s]));
    expect(byName.cal).toMatchObject({
      state: "connected",
      tools: [
        { name: "list_events", readOnly: true },
        { name: "create_event", readOnly: false },
      ],
    });
    expect(byName.mail).toMatchObject({ state: "error", error: "connection refused" });
    expect(byName.off.state).toBe("off");
  });

  it("exposes connected tools to the agent and calls through", async () => {
    const { factory, calls } = fakeFactory({ cal: [{ name: "list_events", readOnly: true }] });
    const m = new McpManager(factory);
    await m.sync([spec("cal")]);

    const [tool] = buildAgentTools(m);
    expect(tool.name).toBe("mcp__cal__list_events");
    expect(tool.description).toContain("read-only");
    const result = await tool.execute("id", { q: "today" });

    expect(result.content[0].text).toBe("list_events ok");
    expect(calls).toEqual([{ server: "cal", name: "list_events", args: { q: "today" } }]);
  });

  it("marks only declared read-only tools as reads, and carries the server's trust", async () => {
    const { factory } = fakeFactory({ cal: [{ name: "a", readOnly: true }, { name: "b" }] });
    const m = new McpManager(factory);
    await m.sync([spec("cal", { trustWrites: true })]);

    expect(listConnectorTools(m).map((e) => [e.name, e.info.readOnly, e.info.trustWrites])).toEqual(
      [
        ["mcp__cal__a", true, true],
        ["mcp__cal__b", false, true],
      ],
    );
  });

  it("drops a server's tools when it is removed or changed", async () => {
    const { factory } = fakeFactory({ cal: [{ name: "a" }] });
    const m = new McpManager(factory);
    const changes = vi.fn();
    m.onChange(changes);
    await m.sync([spec("cal")]);
    await m.sync([]);

    expect(buildAgentTools(m)).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(2);
  });
});

describe("parseServerSpec", () => {
  it("accepts a local program and a remote https server", () => {
    expect(
      parseServerSpec({ name: "Files", transport: "stdio", command: "npx", args: ["-y", "srv"] }),
    ).toMatchObject({
      name: "files",
      transport: "stdio",
      enabled: true,
      trustWrites: false,
    });
    expect(
      parseServerSpec({ name: "cal", transport: "http", url: "https://mcp.example/cal" }).url,
    ).toBe("https://mcp.example/cal");
    expect(
      parseServerSpec({ name: "dev", transport: "http", url: "http://127.0.0.1:9000/mcp" }).url,
    ).toContain("127.0.0.1");
  });

  it("refuses what it should not connect to", () => {
    expect(() =>
      parseServerSpec({ name: "x", transport: "http", url: "http://mcp.example" }),
    ).toThrow(/https/);
    expect(() => parseServerSpec({ name: "Bad Name!", transport: "stdio", command: "x" })).toThrow(
      /name/,
    );
    expect(() => parseServerSpec({ name: "x", transport: "stdio" })).toThrow(/command/);
    expect(() => parseServerSpec({ name: "x", transport: "ftp" })).toThrow(/transport/);
  });
});

describe("tool names and results", () => {
  it("keeps tool names plain and short", () => {
    expect(agentToolName("my.server", "get events!")).toBe("mcp__my_server__get_events_");
    expect(agentToolName("s", "x".repeat(100)).length).toBe(64);
  });

  it("turns an MCP result into text, and marks an error", () => {
    expect(
      toToolResult({ content: [{ type: "image", mimeType: "image/png" }] }).content[0].text,
    ).toBe("[image image/png not shown]");
    expect(
      toToolResult({ isError: true, content: [{ type: "text", text: "quota exceeded" }] }).details,
    ).toEqual({
      status: "error",
      error: "quota exceeded",
    });
  });
});

describe("servers that need a sign-in", () => {
  it("reports needs-sign-in with the address to open, instead of an error", async () => {
    const { FileOAuthProvider } = await import("./oauth.js");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "mcp-oauth-"));
    const factory: McpClientFactory = async (_spec, authProvider) => {
      authProvider?.redirectToAuthorization(new URL("https://auth.example/authorize?x=1"));
      throw new Error("Unauthorized");
    };
    const m = new McpManager(
      factory,
      (s) =>
        new FileOAuthProvider(
          path.join(dir, `${s.name}.json`),
          "http://127.0.0.1:19001/mcp/oauth/callback",
        ),
    );

    await m.sync([spec("cal", { auth: "oauth" })]);

    expect(m.status()[0]).toMatchObject({
      state: "needs-sign-in",
      signInUrl: "https://auth.example/authorize?x=1",
      signedIn: false,
    });
  });
});
