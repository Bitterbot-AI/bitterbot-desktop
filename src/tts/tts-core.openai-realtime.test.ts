import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openaiRealtimeTTS = vi.fn();
const recordUsage = vi.fn();

vi.mock("./openai-realtime-tts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openai-realtime-tts.js")>();
  return { ...actual, openaiRealtimeTTS: (...a: unknown[]) => openaiRealtimeTTS(...a) };
});
vi.mock("../infra/usage-ledger.js", () => ({
  recordUsage: (...a: unknown[]) => recordUsage(...a),
}));

import {
  DEFAULT_OPENAI_TTS_MODEL,
  OPENAI_LEGACY_TTS_MODELS,
  isRetiredModelResponse,
  openaiTTS,
} from "./tts-core.js";

const fetchMock = vi.fn();
const base = {
  text: "Hello there",
  apiKey: "sk-test",
  voice: "alloy",
  responseFormat: "opus" as const,
  timeoutMs: 5000,
};
const RETIRED_BODY = JSON.stringify({
  error: { code: "model_not_found", message: "The model `gpt-4o-mini-tts` has been deprecated." },
});

describe("openaiTTS realtime routing", () => {
  beforeEach(() => {
    openaiRealtimeTTS.mockReset();
    recordUsage.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.OPENAI_TTS_BASE_URL;
    openaiRealtimeTTS.mockResolvedValue({
      audio: Buffer.from("realtime"),
      usage: { inputTokens: 71, outputTokens: 233, totalTokens: 304 },
      attempts: 1,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_TTS_BASE_URL;
  });

  it("defaults to the realtime model and keeps the legacy ones selectable", () => {
    expect(DEFAULT_OPENAI_TTS_MODEL).toBe("gpt-realtime-2.1-mini");
    expect(OPENAI_LEGACY_TTS_MODELS).toEqual(["gpt-4o-mini-tts", "tts-1", "tts-1-hd"]);
  });

  it("sends the realtime model through the Realtime API, not /audio/speech", async () => {
    const audio = await openaiTTS({ ...base, model: "gpt-realtime-2.1-mini" });
    expect(audio.toString()).toBe("realtime");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openaiRealtimeTTS.mock.calls[0]![0]).toMatchObject({
      model: "gpt-realtime-2.1-mini",
      voice: "alloy",
      responseFormat: "opus",
      text: "Hello there",
    });
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      kind: "tts",
      provider: "openai",
      model: "gpt-realtime-2.1-mini",
      usage: { input: 11, output: 233, total: 11 },
      items: 11,
    });
  });

  it("keeps legacy models on /audio/speech while the API accepts them", async () => {
    fetchMock.mockResolvedValue(new Response(Buffer.from("legacy"), { status: 200 }));
    const audio = await openaiTTS({ ...base, model: "gpt-4o-mini-tts" });
    expect(audio.toString()).toBe("legacy");
    expect(openaiRealtimeTTS).not.toHaveBeenCalled();
  });

  it("upgrades to the realtime model once the API reports the legacy model retired", async () => {
    fetchMock.mockResolvedValue(new Response(RETIRED_BODY, { status: 404 }));
    const audio = await openaiTTS({ ...base, model: "gpt-4o-mini-tts" });
    expect(audio.toString()).toBe("realtime");
    expect(openaiRealtimeTTS.mock.calls[0]![0]).toMatchObject({ model: "gpt-realtime-2.1-mini" });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({ model: "gpt-realtime-2.1-mini" });
  });

  it("does not upgrade on unrelated errors", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":{"message":"Rate limit"}}', { status: 429 }),
    );
    await expect(openaiTTS({ ...base, model: "gpt-4o-mini-tts" })).rejects.toThrow(/\(429\)/);
    fetchMock.mockResolvedValue(
      new Response('{"error":{"message":"Invalid input"}}', { status: 400 }),
    );
    await expect(openaiTTS({ ...base, model: "gpt-4o-mini-tts" })).rejects.toThrow(/\(400\)/);
    expect(openaiRealtimeTTS).not.toHaveBeenCalled();
  });

  it("does not upgrade when the voice has no realtime equivalent", async () => {
    fetchMock.mockResolvedValue(new Response(RETIRED_BODY, { status: 404 }));
    await expect(openaiTTS({ ...base, voice: "nova", model: "tts-1" })).rejects.toThrow(/\(404\)/);
    expect(openaiRealtimeTTS).not.toHaveBeenCalled();
  });

  it("never uses the Realtime API for a custom endpoint", async () => {
    process.env.OPENAI_TTS_BASE_URL = "http://localhost:8880/v1";
    fetchMock.mockResolvedValue(new Response(Buffer.from("local"), { status: 200 }));
    const audio = await openaiTTS({ ...base, model: "gpt-realtime-2.1-mini" });
    expect(audio.toString()).toBe("local");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:8880/v1/audio/speech");
    fetchMock.mockResolvedValue(new Response(RETIRED_BODY, { status: 404 }));
    await expect(openaiTTS({ ...base, model: "kokoro" })).rejects.toThrow(/\(404\)/);
    expect(openaiRealtimeTTS).not.toHaveBeenCalled();
  });
});

describe("isRetiredModelResponse", () => {
  it("matches only model-gone answers", () => {
    expect(isRetiredModelResponse(404, RETIRED_BODY)).toBe(true);
    expect(isRetiredModelResponse(400, "The model `tts-1` does not exist")).toBe(true);
    expect(isRetiredModelResponse(400, "Invalid voice")).toBe(false);
    expect(isRetiredModelResponse(500, RETIRED_BODY)).toBe(false);
  });
});
