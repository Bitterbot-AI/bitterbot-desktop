import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeHarness, makeReplyConfig } from "./reply.test-harness.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
  }),
}));

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

const webMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

vi.mock("../web/session.js", () => webMocks);

import { getReplyFromConfig } from "./reply.js";

const { withTempHome } = createTempHomeHarness({
  prefix: "bitterbot-hb-light-",
  beforeEachCase: () => runEmbeddedPiAgentMock.mockClear(),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type RunParams = { provider?: string; model?: string; thinkLevel?: string; isHeartbeat?: boolean };

async function runHeartbeat(cfg: ReturnType<typeof makeReplyConfig>): Promise<RunParams> {
  runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [{ text: "HEARTBEAT_OK" }], meta: {} });
  await getReplyFromConfig(
    {
      Body: "Read HEARTBEAT.md if it exists",
      From: "+1000",
      To: "+2000",
      Provider: "heartbeat",
      SessionKey: "agent:main:main:heartbeat",
    },
    { isHeartbeat: true },
    cfg,
  );
  expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
  return runEmbeddedPiAgentMock.mock.calls[0]?.[0] as RunParams;
}

describe("getReplyFromConfig light heartbeat (token-efficiency build)", () => {
  beforeEach(() => {
    vi.stubEnv("BITTERBOT_TEST_FAST", "1");
  });

  it("defaults a light heartbeat to the cheap tier and pins thinking low", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    await withTempHome(async (home) => {
      const cfg = makeReplyConfig(home);
      cfg.agents.defaults = { ...cfg.agents.defaults, thinkingDefault: "high" } as never;
      const params = await runHeartbeat(cfg);
      expect(params.isHeartbeat).toBe(true);
      expect(params.provider).toBe("anthropic");
      expect(params.model).toBe("claude-haiku-4-5");
      expect(params.thinkLevel).toBe("low");
    });
  });

  it("keeps an explicit heartbeat.model over the cheap default", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    await withTempHome(async (home) => {
      const cfg = makeReplyConfig(home);
      cfg.agents.defaults = {
        ...cfg.agents.defaults,
        heartbeat: { model: "anthropic/claude-sonnet-4-5" },
      } as never;
      const params = await runHeartbeat(cfg);
      expect(params.model).toBe("claude-sonnet-4-5");
    });
  });

  it("falls back to the agent's default model when no cheap-tier key is present", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    await withTempHome(async (home) => {
      const params = await runHeartbeat(makeReplyConfig(home));
      expect(params.provider).toBe("anthropic");
      expect(params.model).toBe("claude-opus-4-5");
    });
  });

  it("uses the primary model and session thinking when lightContext is off", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    await withTempHome(async (home) => {
      const cfg = makeReplyConfig(home);
      cfg.agents.defaults = {
        ...cfg.agents.defaults,
        thinkingDefault: "high",
        heartbeat: { lightContext: false },
      } as never;
      const params = await runHeartbeat(cfg);
      expect(params.model).toBe("claude-opus-4-5");
      expect(params.thinkLevel).toBe("high");
    });
  });
});
