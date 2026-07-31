import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import { channelsHandlers, sanitizeSetupInput } from "./channels.js";

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(),
  listChannelPlugins: vi.fn(() => []),
  normalizeChannelId: (raw: string) => raw,
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

const SECRET = "123456:bot-token-secret";

function capture() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) =>
    calls.push({ ok, payload, error });
  return { calls, respond };
}

function makePlugin(overrides?: Record<string, unknown>) {
  const probeAccount = vi.fn(async () => ({ ok: true, bot: "@my_bot" }));
  const applyAccountConfig = vi.fn(
    ({ cfg, accountId, input }: { cfg: object; accountId: string; input: object }) => ({
      ...cfg,
      channels: { telegram: { accounts: { [accountId]: { ...input } } } },
    }),
  );
  return {
    id: "telegram",
    meta: { id: "telegram", label: "Telegram" },
    setup: { applyAccountConfig },
    status: { probeAccount },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (
        cfg: { channels?: { telegram?: { accounts?: Record<string, unknown> } } },
        accountId?: string | null,
      ) => cfg?.channels?.telegram?.accounts?.[accountId ?? "default"] ?? {},
      defaultAccountId: () => "default",
      isConfigured: (account: { botToken?: string }) => Boolean(account?.botToken),
      unconfiguredReason: () => "botToken missing",
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
});

describe("sanitizeSetupInput", () => {
  it("drops empty strings, sentinels, and null values", () => {
    expect(
      sanitizeSetupInput({
        botToken: `  ${SECRET} `,
        appToken: REDACTED_SENTINEL,
        name: "",
        region: null,
        port: 8080,
      }),
    ).toEqual({ botToken: SECRET, port: 8080 });
  });
});

describe("channels.validate", () => {
  it("probes a draft without persisting anything", async () => {
    const plugin = makePlugin();
    vi.mocked(getChannelPlugin).mockReturnValue(plugin as never);
    const { calls, respond } = capture();

    await channelsHandlers["channels.validate"]!({
      params: { channel: "telegram", input: { botToken: SECRET } },
      respond,
      context: makeContext(),
    } as never);

    expect(calls[0].ok).toBe(true);
    expect(calls[0].payload).toMatchObject({ probed: true, result: { ok: true } });
    expect(plugin.status.probeAccount).toHaveBeenCalledWith(
      expect.objectContaining({ account: expect.objectContaining({ botToken: SECRET }) }),
    );
    expect(vi.mocked(writeConfigFile)).not.toHaveBeenCalled();
  });

  it("reports missing required fields without probing", async () => {
    const plugin = makePlugin();
    vi.mocked(getChannelPlugin).mockReturnValue(plugin as never);
    const { calls, respond } = capture();

    await channelsHandlers["channels.validate"]!({
      params: { channel: "telegram", input: {} },
      respond,
      context: makeContext(),
    } as never);

    expect(calls[0].ok).toBe(true);
    expect(calls[0].payload).toMatchObject({
      probed: false,
      result: { ok: false, error: "botToken missing" },
    });
    expect(plugin.status.probeAccount).not.toHaveBeenCalled();
  });

  it("rejects channels without a setup adapter", async () => {
    vi.mocked(getChannelPlugin).mockReturnValue(makePlugin({ setup: undefined }) as never);
    const { calls, respond } = capture();
    await channelsHandlers["channels.validate"]!({
      params: { channel: "telegram", input: { botToken: SECRET } },
      respond,
      context: makeContext(),
    } as never);
    expect(calls[0].ok).toBe(false);
  });
});

describe("channels.configure", () => {
  it("persists sanitized input, hot-restarts the account, and returns a probe", async () => {
    const plugin = makePlugin();
    vi.mocked(getChannelPlugin).mockReturnValue(plugin as never);
    const context = makeContext();
    const { calls, respond } = capture();

    await channelsHandlers["channels.configure"]!({
      params: {
        channel: "telegram",
        input: { botToken: SECRET, stale: REDACTED_SENTINEL },
      },
      respond,
      context,
    } as never);

    expect(plugin.setup.applyAccountConfig).toHaveBeenCalledWith(
      expect.objectContaining({ input: { botToken: SECRET } }),
    );
    expect(vi.mocked(writeConfigFile)).toHaveBeenCalled();
    expect(context.stopChannel).toHaveBeenCalledWith("telegram", "default");
    expect(context.startChannel).toHaveBeenCalledWith("telegram", "default");
    expect(calls[0].ok).toBe(true);
    expect(calls[0].payload).toMatchObject({
      ok: true,
      runtime: "started",
      configured: true,
      probe: { ok: true },
    });
  });

  it("surfaces validateInput failures as request errors without writing", async () => {
    const plugin = makePlugin();
    (plugin.setup as Record<string, unknown>).validateInput = () => "botToken looks malformed";
    vi.mocked(getChannelPlugin).mockReturnValue(plugin as never);
    const { calls, respond } = capture();

    await channelsHandlers["channels.configure"]!({
      params: { channel: "telegram", input: { botToken: "bad" } },
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

    await channelsHandlers["channels.configure"]!({
      params: { channel: "telegram", input: { botToken: SECRET } },
      respond,
      context: makeContext(),
    } as never);

    expect(calls[0].ok).toBe(false);
    expect(vi.mocked(writeConfigFile)).not.toHaveBeenCalled();
  });
});
