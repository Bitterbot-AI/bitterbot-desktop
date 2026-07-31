import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import {
  __resetChannelCapabilityCacheForTest,
  buildChannelCapabilities,
  channelsHandlers,
} from "./channels.js";

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(),
  listChannelPlugins: vi.fn(() => []),
  normalizeChannelId: (raw: string) => (raw === "bogus" ? null : raw),
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn(async () => {}),
}));
vi.mock("../../channels/plugins/catalog.js", () => ({
  buildChannelUiCatalog: vi.fn(() => ({
    order: [],
    labels: {},
    detailLabels: {},
    systemImages: {},
    entries: {},
  })),
}));

function capture() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) =>
    calls.push({ ok, payload, error });
  return { calls, respond };
}

function makePlugin(overrides?: Record<string, unknown>) {
  return {
    id: "telegram",
    meta: { id: "telegram", label: "Telegram" },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      defaultAccountId: () => "default",
      setAccountEnabled: vi.fn(({ cfg, accountId, enabled }) => ({
        ...cfg,
        channels: { telegram: { accounts: { [accountId]: { enabled } } } },
      })),
    },
    ...overrides,
  };
}

function makeContext() {
  return {
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.mocked(getChannelPlugin).mockReset();
  vi.mocked(readConfigFileSnapshot)
    .mockReset()
    .mockResolvedValue({ valid: true, config: {} } as never);
  vi.mocked(writeConfigFile).mockClear();
  __resetChannelCapabilityCacheForTest();
});

describe("channels.update", () => {
  it("writes the enabled flag and starts the account in-process", async () => {
    const plugin = makePlugin();
    vi.mocked(getChannelPlugin).mockReturnValue(plugin as never);
    const context = makeContext();
    const { calls, respond } = capture();

    await channelsHandlers["channels.update"]!({
      params: { channel: "telegram", accountId: "default", enabled: true },
      respond,
      context,
    } as never);

    expect(plugin.config.setAccountEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", enabled: true }),
    );
    expect(vi.mocked(writeConfigFile)).toHaveBeenCalled();
    // Explicit lifecycle: the watcher can't be relied on for channels that
    // declare their config prefix as a noop (WhatsApp).
    expect(context.startChannel).toHaveBeenCalledWith("telegram", "default");
    expect(context.stopChannel).not.toHaveBeenCalled();
    expect(calls[0].ok).toBe(true);
    expect(calls[0].payload).toMatchObject({ enabled: true, runtime: "started" });
  });

  it("stops the account when disabling", async () => {
    const plugin = makePlugin();
    vi.mocked(getChannelPlugin).mockReturnValue(plugin as never);
    const context = makeContext();
    const { calls, respond } = capture();

    await channelsHandlers["channels.update"]!({
      params: { channel: "telegram", enabled: false },
      respond,
      context,
    } as never);

    expect(context.stopChannel).toHaveBeenCalledWith("telegram", "default");
    expect(calls[0].payload).toMatchObject({ enabled: false, runtime: "stopped" });
  });

  it("reports a runtime start failure without failing the config write", async () => {
    const plugin = makePlugin();
    vi.mocked(getChannelPlugin).mockReturnValue(plugin as never);
    const context = makeContext();
    context.startChannel.mockRejectedValue(new Error("not configured"));
    const { calls, respond } = capture();

    await channelsHandlers["channels.update"]!({
      params: { channel: "telegram", enabled: true },
      respond,
      context,
    } as never);

    expect(vi.mocked(writeConfigFile)).toHaveBeenCalled();
    expect(calls[0].ok).toBe(true);
    expect((calls[0].payload as { runtime: string }).runtime).toContain("error");
  });

  it("rejects channels without setAccountEnabled support", async () => {
    const plugin = makePlugin();
    delete (plugin.config as Record<string, unknown>).setAccountEnabled;
    vi.mocked(getChannelPlugin).mockReturnValue(plugin as never);
    const { calls, respond } = capture();

    await channelsHandlers["channels.update"]!({
      params: { channel: "telegram", enabled: true },
      respond,
      context: makeContext(),
    } as never);

    expect(calls[0].ok).toBe(false);
    expect(vi.mocked(writeConfigFile)).not.toHaveBeenCalled();
  });

  it("refuses to write when the config file is invalid", async () => {
    vi.mocked(getChannelPlugin).mockReturnValue(makePlugin() as never);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({ valid: false, issues: [] } as never);
    const { calls, respond } = capture();

    await channelsHandlers["channels.update"]!({
      params: { channel: "telegram", enabled: true },
      respond,
      context: makeContext(),
    } as never);

    expect(calls[0].ok).toBe(false);
    expect(vi.mocked(writeConfigFile)).not.toHaveBeenCalled();
  });
});

describe("buildChannelCapabilities", () => {
  it("marks channels unsupported when the gateway host platform does not match", async () => {
    const plugin = makePlugin({
      id: "imessage",
      meta: { id: "imessage", label: "iMessage", platforms: ["darwin"] },
    });
    const result = await buildChannelCapabilities({
      plugins: [plugin as never],
      cfg: {} as never,
    });
    if (process.platform === "darwin") {
      expect(result.imessage.supported).toBe(true);
    } else {
      expect(result.imessage.supported).toBe(false);
      expect(result.imessage.reason).toContain("darwin");
    }
    expect(result.imessage.platforms).toEqual(["darwin"]);
  });

  it("runs the plugin availability probe and surfaces its reason", async () => {
    const plugin = makePlugin({
      id: "signal",
      meta: { id: "signal", label: "Signal" },
      availability: async () => ({ available: false, reason: "signal-cli not found" }),
    });
    const result = await buildChannelCapabilities({
      plugins: [plugin as never],
      cfg: {} as never,
    });
    expect(result.signal).toEqual({ supported: false, reason: "signal-cli not found" });
  });

  it("defaults to supported when no platforms or availability are declared", async () => {
    const plugin = makePlugin();
    const result = await buildChannelCapabilities({
      plugins: [plugin as never],
      cfg: {} as never,
    });
    expect(result.telegram).toEqual({ supported: true });
  });
});
