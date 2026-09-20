import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setWhatsAppRuntime } from "../../extensions/whatsapp/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { __resetConsiderationsForTest, recentConsiderations } from "./heartbeat-considerations.js";
import { __resetHeartbeatHashStateForTest } from "./heartbeat-gate.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

type Fixture = { tmpDir: string; storePath: string; cfg: BitterbotConfig; sessionKey: string };

async function withFixture(
  heartbeat: NonNullable<NonNullable<BitterbotConfig["agents"]>["defaults"]>["heartbeat"],
  run: (fx: Fixture) => Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-hb-gate-runner-"));
  const storePath = path.join(tmpDir, "sessions.json");
  const cfg: BitterbotConfig = {
    agents: {
      defaults: {
        workspace: tmpDir,
        heartbeat: { every: "5m", target: "whatsapp", ...heartbeat },
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
  const sessionKey = resolveMainSessionKey(cfg);
  await fs.writeFile(
    storePath,
    JSON.stringify({
      [sessionKey]: {
        sessionId: "sid",
        updatedAt: Date.now(),
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
    }),
  );
  try {
    await run({ tmpDir, storePath, cfg, sessionKey });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const deps = { getQueueSize: () => 0, nowMs: () => 0 };

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setWhatsAppRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]),
  );
  __resetHeartbeatHashStateForTest();
  __resetConsiderationsForTest();
  resetSystemEventsForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetHeartbeatHashStateForTest();
  __resetConsiderationsForTest();
  resetSystemEventsForTest();
});

describe("runHeartbeatOnce – content-hash gate", () => {
  it("calls the model once for unchanged inputs, then skips with reason unchanged-hash", async () => {
    await withFixture({}, async ({ tmpDir, cfg, sessionKey }) => {
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "# HB\n- check inbox\n");
      const replySpy = vi
        .spyOn(replyModule, "getReplyFromConfig")
        .mockResolvedValue({ text: "HEARTBEAT_OK" });

      const first = await runHeartbeatOnce({ cfg, reason: "interval", deps });
      expect(first.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);

      const second = await runHeartbeatOnce({ cfg, reason: "interval", deps });
      expect(second).toEqual({ status: "skipped", reason: "unchanged-hash" });
      expect(replySpy).toHaveBeenCalledTimes(1);

      // cache-warm early fires are schedule-driven too.
      const third = await runHeartbeatOnce({ cfg, reason: "cache-warm", deps });
      expect(third).toEqual({ status: "skipped", reason: "unchanged-hash" });
      expect(replySpy).toHaveBeenCalledTimes(1);

      const why = recentConsiderations({ sessionKey, decision: "skipped" });
      expect(why[0]?.reason).toBe("unchanged-hash");
      expect(why[0]?.subject).toBe("heartbeat-tick");
    });
  });

  it("calls the model again when HEARTBEAT.md changes", async () => {
    await withFixture({}, async ({ tmpDir, cfg }) => {
      const file = path.join(tmpDir, "HEARTBEAT.md");
      await fs.writeFile(file, "# HB\n- check inbox\n");
      const replySpy = vi
        .spyOn(replyModule, "getReplyFromConfig")
        .mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({ cfg, reason: "interval", deps });
      // Cosmetic edit: still unchanged.
      await fs.writeFile(file, "# HB   \r\n- check inbox   \r\n\r\n\r\n");
      expect(await runHeartbeatOnce({ cfg, reason: "interval", deps })).toEqual({
        status: "skipped",
        reason: "unchanged-hash",
      });
      // Content edit: runs.
      await fs.writeFile(file, "# HB\n- check inbox\n- check calendar\n");
      const res = await runHeartbeatOnce({ cfg, reason: "interval", deps });
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(2);
    });
  });

  it("does not gate wake / exec / cron / hook / manual reasons", async () => {
    await withFixture({}, async ({ tmpDir, cfg }) => {
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "# HB\n- check inbox\n");
      const replySpy = vi
        .spyOn(replyModule, "getReplyFromConfig")
        .mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({ cfg, reason: "interval", deps });
      for (const reason of ["wake", "hook:github", "manual", "cron:job-1"]) {
        const res = await runHeartbeatOnce({ cfg, reason, deps });
        expect(res.status, reason).toBe("ran");
      }
      expect(replySpy).toHaveBeenCalledTimes(5);
      // The bypassing runs did not move the baseline: the next interval tick is still unchanged.
      expect(await runHeartbeatOnce({ cfg, reason: "interval", deps })).toEqual({
        status: "skipped",
        reason: "unchanged-hash",
      });
    });
  });

  it("does not commit the baseline when the model call fails", async () => {
    await withFixture({}, async ({ tmpDir, cfg }) => {
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "# HB\n- check inbox\n");
      const replySpy = vi
        .spyOn(replyModule, "getReplyFromConfig")
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ text: "HEARTBEAT_OK" });

      expect((await runHeartbeatOnce({ cfg, reason: "interval", deps })).status).toBe("failed");
      expect((await runHeartbeatOnce({ cfg, reason: "interval", deps })).status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(2);
    });
  });

  it("can be disabled with skipWhenUnchanged: false", async () => {
    await withFixture({ skipWhenUnchanged: false }, async ({ tmpDir, cfg }) => {
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "# HB\n- check inbox\n");
      const replySpy = vi
        .spyOn(replyModule, "getReplyFromConfig")
        .mockResolvedValue({ text: "HEARTBEAT_OK" });
      await runHeartbeatOnce({ cfg, reason: "interval", deps });
      await runHeartbeatOnce({ cfg, reason: "interval", deps });
      expect(replySpy).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps the empty-file gate ahead of the hash gate", async () => {
    await withFixture({}, async ({ tmpDir, cfg }) => {
      await fs.writeFile(
        path.join(tmpDir, "HEARTBEAT.md"),
        "_No active heartbeat tasks. If nothing needs attention, reply HEARTBEAT_OK._\n",
      );
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      expect(await runHeartbeatOnce({ cfg, reason: "interval", deps })).toEqual({
        status: "skipped",
        reason: "empty-heartbeat-file",
      });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });
});

describe("runHeartbeatOnce – isolated light session", () => {
  it("runs interval ticks in `<main>:heartbeat` with a fresh transcript, delivering via the main entry", async () => {
    await withFixture({}, async ({ tmpDir, storePath, cfg, sessionKey }) => {
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "# HB\n- check inbox\n");
      const isolatedKey = `${sessionKey}:heartbeat`;
      const staleTranscript = path.join(tmpDir, "stale-hb.jsonl");
      await fs.writeFile(staleTranscript, "{}\n");
      const store = JSON.parse(await fs.readFile(storePath, "utf-8"));
      store[isolatedKey] = { sessionId: "stale", sessionFile: staleTranscript, updatedAt: 1 };
      await fs.writeFile(storePath, JSON.stringify(store));

      const replySpy = vi
        .spyOn(replyModule, "getReplyFromConfig")
        .mockResolvedValue({ text: "Inbox has 2 urgent mails" });
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const res = await runHeartbeatOnce({
        cfg,
        reason: "interval",
        deps: {
          ...deps,
          sendWhatsApp,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({ SessionKey: isolatedKey, From: "+1555", To: "+1555" }),
        { isHeartbeat: true },
        cfg,
      );
      // Delivery still resolves from the main entry's last route.
      expect(sendWhatsApp).toHaveBeenCalledWith(
        "+1555",
        "Inbox has 2 urgent mails",
        expect.any(Object),
      );
      // The previous isolated transcript was dropped before the run.
      await expect(fs.access(staleTranscript)).rejects.toThrow();
      const after = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(after[isolatedKey]).toBeUndefined();
      expect(after[sessionKey]?.sessionId).toBe("sid");
    });
  });

  it("stays in the main session when system events are queued for it", async () => {
    await withFixture({}, async ({ tmpDir, cfg, sessionKey }) => {
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "# HB\n- check inbox\n");
      enqueueSystemEvent("Exec finished: build ok", { sessionKey });
      const replySpy = vi
        .spyOn(replyModule, "getReplyFromConfig")
        .mockResolvedValue({ text: "HEARTBEAT_OK" });
      await runHeartbeatOnce({ cfg, reason: "interval", deps });
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({ SessionKey: sessionKey }),
        { isHeartbeat: true },
        cfg,
      );
    });
  });

  it("stays in the main session when isolatedSession is false", async () => {
    await withFixture({ isolatedSession: false }, async ({ tmpDir, cfg, sessionKey }) => {
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "# HB\n- check inbox\n");
      const replySpy = vi
        .spyOn(replyModule, "getReplyFromConfig")
        .mockResolvedValue({ text: "HEARTBEAT_OK" });
      await runHeartbeatOnce({ cfg, reason: "interval", deps });
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({ SessionKey: sessionKey }),
        { isHeartbeat: true },
        cfg,
      );
    });
  });
});
