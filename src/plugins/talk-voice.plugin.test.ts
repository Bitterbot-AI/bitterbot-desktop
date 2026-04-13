/**
 * Tests for the talk-voice extension plugin.
 *
 * Exercises:
 * - Plugin registration (registerCommand is called with "voice")
 * - /voice status — returns status text with voice config
 * - /voice list — calls ElevenLabs API, formats voice list
 * - /voice set <name> — resolves voice, writes config
 * - /voice set <unknown> — returns "not found" message
 * - /voice (no args) — returns status
 * - /voice help — returns usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BitterbotPluginApi } from "./types.js";
import register from "../../extensions/talk-voice/index.js";

type CommandHandler = (ctx: { args?: string }) => Promise<{ text: string }>;

const MOCK_VOICES = [
  { voice_id: "v1_rachel", name: "Rachel", category: "premade", description: "Warm female" },
  { voice_id: "v2_drew", name: "Drew", category: "premade", description: "Deep male" },
  { voice_id: "v3_custom", name: "My Custom Voice", category: "cloned" },
];

function mockElevenLabsSuccess() {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok: true,
    json: async () => ({ voices: MOCK_VOICES }),
  } as Response);
}

function createMockApi(configOverride?: Record<string, unknown>): {
  api: BitterbotPluginApi;
  registeredCommands: Map<string, { description: string; handler: CommandHandler }>;
} {
  const registeredCommands = new Map<string, { description: string; handler: CommandHandler }>();

  const api = {
    id: "talk-voice",
    name: "Talk Voice",
    source: "test",
    config: {},
    runtime: {
      config: {
        loadConfig: vi.fn(() => ({
          talk: {
            apiKey: "test-api-key-123456",
            voiceId: "abc123voice",
          },
          ...configOverride,
        })),
        writeConfigFile: vi.fn(async () => {}),
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerCommand: vi.fn(
      (cmd: { name: string; description: string; handler: CommandHandler }) => {
        registeredCommands.set(cmd.name, { description: cmd.description, handler: cmd.handler });
      },
    ),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    resolvePath: vi.fn((s: string) => s),
    on: vi.fn(),
  } as unknown as BitterbotPluginApi;

  return { api, registeredCommands };
}

describe("talk-voice plugin", () => {
  let registeredCommands: Map<string, { description: string; handler: CommandHandler }>;
  let handler: CommandHandler;

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api);
    registeredCommands = mock.registeredCommands;
    handler = registeredCommands.get("voice")!.handler;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a 'voice' command", () => {
    expect(registeredCommands.has("voice")).toBe(true);
    expect(registeredCommands.get("voice")!.description).toContain("ElevenLabs");
  });

  it("/voice status — returns config status", async () => {
    const result = await handler({ args: "status" });
    expect(result.text).toContain("talk.voiceId:");
    expect(result.text).toContain("abc123voice");
    expect(result.text).toContain("talk.apiKey:");
  });

  it("/voice (no args) — returns status", async () => {
    const result = await handler({ args: "" });
    expect(result.text).toContain("talk.voiceId:");
  });

  it("/voice list — fetches and formats voice list", async () => {
    mockElevenLabsSuccess();
    const result = await handler({ args: "list" });
    expect(globalThis.fetch).toHaveBeenCalledWith("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": "test-api-key-123456" },
    });
    expect(result.text).toContain("Rachel");
    expect(result.text).toContain("v1_rachel");
    expect(result.text).toContain("Drew");
  });

  it("/voice set <name> — resolves by name and writes config", async () => {
    mockElevenLabsSuccess();
    const mock = createMockApi();
    register(mock.api);
    const h = mock.registeredCommands.get("voice")!.handler;

    const result = await h({ args: "set Rachel" });
    expect(result.text).toContain("Rachel");
    expect(result.text).toContain("v1_rachel");
    expect(mock.api.runtime.config.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        talk: expect.objectContaining({ voiceId: "v1_rachel" }),
      }),
    );
  });

  it("/voice set <id> — resolves by voice_id", async () => {
    mockElevenLabsSuccess();
    const result = await handler({ args: "set v2_drew" });
    expect(result.text).toContain("Drew");
  });

  it("/voice set <unknown> — returns not-found message", async () => {
    mockElevenLabsSuccess();
    const result = await handler({ args: "set nonexistent-voice-name" });
    expect(result.text).toContain("No voice found");
    expect(result.text).toContain("/voice list");
  });

  it("returns not-configured when apiKey is missing", async () => {
    const mock = createMockApi({ talk: { apiKey: "" } });
    register(mock.api);
    const h = mock.registeredCommands.get("voice")!.handler;
    const result = await h({ args: "list" });
    expect(result.text).toContain("not configured");
    expect(result.text).toContain("talk.apiKey");
  });

  it("/voice help — shows usage for unknown action", async () => {
    const result = await handler({ args: "unknown" });
    expect(result.text).toContain("/voice status");
    expect(result.text).toContain("/voice list");
    expect(result.text).toContain("/voice set");
  });
});
