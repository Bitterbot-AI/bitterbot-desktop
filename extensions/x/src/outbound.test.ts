import type { BitterbotConfig } from "bitterbot/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLedger } from "./ledger.js";
import { parseXTarget, xOutbound } from "./outbound.js";
import { writeTokenRecord } from "./token-store.js";

const createPost = vi.fn();
vi.mock("./api.js", () => ({
  createPost: (...args: unknown[]) => createPost(...args),
}));

describe("parseXTarget", () => {
  it("maps timeline aliases and the bot's own handle to timeline", () => {
    for (const to of ["", "timeline", "ME", "self", "x", "@BitterBot_AI", "bitterbot_ai"]) {
      expect(parseXTarget(to, "bitterbot_ai")).toEqual({ kind: "timeline" });
    }
  });
  it("parses reply targets and rejects anything else", () => {
    expect(parseXTarget("reply:1234567890")).toEqual({ kind: "reply", postId: "1234567890" });
    expect(parseXTarget("@someone_else", "bitterbot_ai")).toBeNull();
    expect(parseXTarget("reply:abc")).toBeNull();
  });
});

describe("xOutbound", () => {
  let dir: string;
  let cfg: BitterbotConfig;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "x-out-"));
    vi.stubEnv("BITTERBOT_STATE_DIR", dir);
    cfg = {
      channels: { x: { clientId: "cid", handle: "bitterbot_ai" } },
    } as unknown as BitterbotConfig;
    await writeTokenRecord(path.join(dir, "x", "default.token.json"), {
      accessToken: "tok",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
      obtainedAt: 0,
      username: "bitterbot_ai",
    });
    createPost.mockReset();
    createPost.mockResolvedValue({
      id: "111",
      text: "Day 0.",
      url: "https://x.com/bitterbot_ai/status/111",
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("never chunks", () => {
    expect(xOutbound.deliveryMode).toBe("direct");
    expect(xOutbound.chunker?.("a".repeat(1000), 280)).toEqual(["a".repeat(1000)]);
  });

  it("resolveTarget normalizes and rejects unknown targets", () => {
    expect(xOutbound.resolveTarget?.({ cfg, to: "me", accountId: "default" })).toEqual({
      ok: true,
      to: "timeline",
    });
    expect(xOutbound.resolveTarget?.({ cfg, to: "reply:123456", accountId: "default" })).toEqual({
      ok: true,
      to: "reply:123456",
    });
    const bad = xOutbound.resolveTarget?.({ cfg, to: "@victor", accountId: "default" });
    expect(bad?.ok).toBe(false);
  });

  it("refuses heartbeat and implicit delivery so acks never become public posts", () => {
    for (const mode of ["heartbeat", "implicit"] as const) {
      const res = xOutbound.resolveTarget?.({ cfg, to: "timeline", accountId: "default", mode });
      expect(res?.ok).toBe(false);
      expect(!res?.ok && String(res?.error)).toMatch(/explicit targets/);
    }
    expect(
      xOutbound.resolveTarget?.({ cfg, to: "timeline", accountId: "default", mode: "explicit" })
        ?.ok,
    ).toBe(true);
  });

  it("posts, appends the ledger, and returns the permalink", async () => {
    const res = await xOutbound.sendText!({
      cfg,
      to: "timeline",
      text: "Day 0. Victor gave me an X account.",
      accountId: "default",
    });
    expect(res).toMatchObject({
      channel: "x",
      messageId: "111",
      meta: { url: "https://x.com/bitterbot_ai/status/111" },
    });
    expect(createPost).toHaveBeenCalledTimes(1);
    expect(createPost.mock.calls[0][1]).toMatchObject({
      text: "Day 0. Victor gave me an X account.",
      replyToId: undefined,
    });
    const ledger = await readLedger({ accountId: "default" });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ id: "111", kind: "post" });
  });

  it("blocks by policy before any API call and explains why", async () => {
    await expect(
      xOutbound.sendText!({
        cfg,
        to: "timeline",
        text: "check out https://bitterbot.ai",
        accountId: "default",
      }),
    ).rejects.toThrow(/blocked by policy: links are disabled/);
    await expect(
      xOutbound.sendText!({ cfg, to: "reply:123456", text: "hi", accountId: "default" }),
    ).rejects.toThrow(/replies are disabled/);
    expect(createPost).not.toHaveBeenCalled();
  });

  it("enforces the daily cap across sends via the ledger", async () => {
    const quick = {
      channels: { x: { clientId: "cid", policy: { minIntervalMinutes: 0, maxPostsPerDay: 2 } } },
    } as unknown as BitterbotConfig;
    await xOutbound.sendText!({
      cfg: quick,
      to: "timeline",
      text: "first post today",
      accountId: "default",
    });
    createPost.mockResolvedValue({ id: "112", text: "second", url: "u" });
    await xOutbound.sendText!({
      cfg: quick,
      to: "timeline",
      text: "second, unrelated words entirely",
      accountId: "default",
    });
    await expect(
      xOutbound.sendText!({
        cfg: quick,
        to: "timeline",
        text: "third attempt of the day",
        accountId: "default",
      }),
    ).rejects.toThrow(/daily cap reached \(2\/2/);
    expect(createPost).toHaveBeenCalledTimes(2);
  });

  it("does not append to the ledger when the API call fails", async () => {
    createPost.mockRejectedValue(new Error("X API POST /tweets failed (403): duplicate content"));
    await expect(
      xOutbound.sendText!({ cfg, to: "timeline", text: "hello", accountId: "default" }),
    ).rejects.toThrow(/403/);
    expect(await readLedger({ accountId: "default" })).toHaveLength(0);
  });

  it("honours the kill switch and the enabled flag", async () => {
    await fs.writeFile(path.join(dir, "x", "KILL"), "now\n");
    await expect(
      xOutbound.sendText!({ cfg, to: "timeline", text: "hello", accountId: "default" }),
    ).rejects.toThrow(/kill switch/);
    await fs.rm(path.join(dir, "x", "KILL"));
    const off = {
      channels: { x: { clientId: "cid", enabled: false } },
    } as unknown as BitterbotConfig;
    await expect(
      xOutbound.sendText!({ cfg: off, to: "timeline", text: "hello", accountId: "default" }),
    ).rejects.toThrow(/disabled/);
    expect(createPost).not.toHaveBeenCalled();
  });

  it("refuses media", async () => {
    await expect(
      xOutbound.sendMedia!({
        cfg,
        to: "timeline",
        text: "pic",
        mediaUrl: "https://a/b.png",
        accountId: "default",
      }),
    ).rejects.toThrow(/media/);
  });
});
