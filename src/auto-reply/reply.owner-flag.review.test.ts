/**
 * From the adversarial review: the owner flag has to reach the embedded
 * runner on the reply path (every channel message and the Control UI
 * `chat.send`). It was computed and then dropped, so the owner-only tools
 * (browser, code interpreter, wallet) were missing for the real owner on
 * every chat surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { createTempHomeHarness, makeReplyConfig } from "./reply.test-harness.js";

const agentMocks = vi.hoisted(() => ({
  runEmbeddedPiAgent: vi.fn(),
  loadModelCatalog: vi.fn(),
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

vi.mock("../agents/embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: agentMocks.runEmbeddedPiAgent,
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: agentMocks.loadModelCatalog,
}));

vi.mock("../web/session.js", () => ({
  webAuthExists: agentMocks.webAuthExists,
  getWebAuthAgeMs: agentMocks.getWebAuthAgeMs,
  readWebSelfId: agentMocks.readWebSelfId,
}));

import { resolveCommandAuthorization } from "./command-auth.js";
import { getReplyFromConfig } from "./reply.js";

const { withTempHome } = createTempHomeHarness({ prefix: "bitterbot-ownerflag-" });

describe("owner flag on the reply path (review)", () => {
  beforeEach(() => {
    vi.stubEnv("BITTERBOT_TEST_FAST", "1");
    agentMocks.runEmbeddedPiAgent.mockReset();
    agentMocks.loadModelCatalog.mockReset();
    agentMocks.loadModelCatalog.mockResolvedValue([
      { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
    ]);
    agentMocks.runEmbeddedPiAgent.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const whatsappCtx = (from: string) => ({
    Body: "send 1 USDC to 0xabc",
    BodyForAgent: "send 1 USDC to 0xabc",
    RawBody: "send 1 USDC to 0xabc",
    From: from,
    To: "+1999",
    Provider: "whatsapp",
    Surface: "whatsapp",
    ChatType: "direct",
    SenderE164: from,
    SenderId: from,
    CommandAuthorized: true,
  });
  const lastRunParams = () =>
    agentMocks.runEmbeddedPiAgent.mock.calls.at(-1)?.[0] as { senderIsOwner?: boolean };

  it("an owner DM reaches the run as an owner turn", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        ...makeReplyConfig(home),
        channels: { whatsapp: { allowFrom: ["+1222", "+1333"] } },
        commands: { ownerAllowFrom: ["+1222"] },
      } as unknown as BitterbotConfig;
      const ctx = whatsappCtx("+1222");
      expect(resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true }).senderIsOwner).toBe(
        true,
      );
      await getReplyFromConfig(ctx, {}, cfg);
      expect(agentMocks.runEmbeddedPiAgent).toHaveBeenCalledOnce();
      expect(lastRunParams().senderIsOwner).toBe(true);
    });
  });

  it("an allowed sender who is not an owner reaches the run as a non-owner turn", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        ...makeReplyConfig(home),
        channels: { whatsapp: { allowFrom: ["+1222", "+1333"] } },
        commands: { ownerAllowFrom: ["+1222"] },
      } as unknown as BitterbotConfig;
      await getReplyFromConfig(whatsappCtx("+1333"), {}, cfg);
      expect(agentMocks.runEmbeddedPiAgent).toHaveBeenCalledOnce();
      expect(lastRunParams().senderIsOwner).toBe(false);
    });
  });

  it("the Control UI chat.send context is an owner surface", async () => {
    await withTempHome(async (home) => {
      // Even with an owner list that names only a phone number.
      const cfg = {
        ...makeReplyConfig(home),
        commands: { ownerAllowFrom: ["+1222"] },
      } as unknown as BitterbotConfig;
      // The context src/gateway/server-methods/chat.ts builds.
      const ctx = {
        Body: "check my wallet balance",
        BodyForAgent: "check my wallet balance",
        RawBody: "check my wallet balance",
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        ChatType: "direct",
        CommandAuthorized: true,
        SenderId: "bitterbot-control-ui",
        SessionKey: "agent:main:main",
      };
      const auth = resolveCommandAuthorization({
        ctx: ctx as never,
        cfg,
        commandAuthorized: true,
      });
      expect(auth.senderIsOwner).toBe(true);
      await getReplyFromConfig(ctx as never, {}, cfg);
      expect(agentMocks.runEmbeddedPiAgent).toHaveBeenCalledOnce();
      expect(lastRunParams().senderIsOwner).toBe(true);
    });
  });

  it("a channel message cannot pass for the Control UI by naming its surface", () => {
    const cfg = { commands: { ownerAllowFrom: ["+1222"] } } as unknown as BitterbotConfig;
    const ctx = { ...whatsappCtx("+1333"), Surface: "webchat" };
    expect(resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true }).senderIsOwner).toBe(
      false,
    );
  });
});
