import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runCapability = vi.hoisted(() => vi.fn());
const textToSpeech = vi.hoisted(() => vi.fn());
let seenPath: string | undefined;

vi.mock("../../media-understanding/runner.js", async (orig) => ({
  ...(await orig<typeof import("../../media-understanding/runner.js")>()),
  runCapability: (args: { ctx: { MediaPath?: string } }) => {
    seenPath = args.ctx.MediaPath;
    return runCapability(args);
  },
}));
vi.mock("../../tts/tts.js", () => ({ textToSpeech }));
vi.mock("../../config/config.js", async (orig) => ({
  ...(await orig<typeof import("../../config/config.js")>()),
  loadConfig: () => ({}),
}));

const { talkHandlers } = await import("./talk.js");

type Reply = { ok: boolean; payload?: Record<string, unknown>; error?: { message?: string } };
async function call(method: string, params: Record<string, unknown>): Promise<Reply> {
  let reply: Reply = { ok: false };
  await talkHandlers[method]({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      reply = { ok, payload: payload as Record<string, unknown>, error: error as Reply["error"] };
    },
    context: { broadcast: vi.fn() },
  } as never);
  return reply;
}

beforeEach(() => {
  runCapability.mockReset();
  textToSpeech.mockReset();
  seenPath = undefined;
});

describe("talk.transcribe", () => {
  it("turns a spoken turn into text and deletes the audio", async () => {
    runCapability.mockResolvedValue({
      outputs: [{ kind: "audio.transcription", text: " book a table for two " }],
      decision: { outcome: "success" },
    });
    const res = await call("talk.transcribe", {
      audio: Buffer.from("fake-webm").toString("base64"),
      mimeType: "audio/webm;codecs=opus",
    });
    expect(res).toMatchObject({ ok: true, payload: { text: "book a table for two" } });
    expect(seenPath).toMatch(/\.webm$/);
    await expect(fs.access(seenPath!)).rejects.toThrow();
  });

  it("explains a missing speech provider and refuses unknown audio", async () => {
    runCapability.mockResolvedValue({ outputs: [], decision: { outcome: "skipped" } });
    const none = await call("talk.transcribe", {
      audio: Buffer.from("x").toString("base64"),
      mimeType: "audio/webm",
    });
    expect(none.error?.message).toMatch(/speech to text is not available/);
    const bad = await call("talk.transcribe", { audio: "eA==", mimeType: "video/mp4" });
    expect(bad.ok).toBe(false);
    expect(runCapability).toHaveBeenCalledTimes(1);
  });
});

describe("talk.speak", () => {
  it("returns the spoken reply as audio bytes and removes the file", async () => {
    const file = path.join(os.tmpdir(), `talk-speak-${Date.now()}.mp3`);
    await fs.writeFile(file, Buffer.from("ID3audio"));
    textToSpeech.mockResolvedValue({ success: true, audioPath: file, provider: "edge" });
    const res = await call("talk.speak", { text: "Done. Your table is booked." });
    expect(res).toMatchObject({ ok: true, payload: { mimeType: "audio/mpeg", provider: "edge" } });
    expect(Buffer.from(String(res.payload?.audio), "base64").toString()).toBe("ID3audio");
    await expect(fs.access(file)).rejects.toThrow();
  });
});

describe("talk.mode", () => {
  it("works without a phone node connected", async () => {
    const res = await call("talk.mode", { enabled: true, phase: "listening" });
    expect(res).toMatchObject({ ok: true, payload: { enabled: true, phase: "listening" } });
  });
});
