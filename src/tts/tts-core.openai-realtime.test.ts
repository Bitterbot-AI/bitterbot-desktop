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
  OPENAI_LEGACY_TTS_SHUTDOWN_MS,
  isRetiredModelResponse,
  openaiTTS,
  resetOpenAiTtsStateForTest,
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
    resetOpenAiTtsStateForTest();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.OPENAI_TTS_BASE_URL;
    openaiRealtimeTTS.mockImplementation(
      async (_params: unknown, deps: { onSession?: (u: unknown) => void }) => {
        const usage = { inputTokens: 71, outputTokens: 233, totalTokens: 304 };
        deps.onSession?.(usage);
        return { audio: Buffer.from("realtime"), usage, attempts: 1, voice: "alloy" };
      },
    );
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

  it("gives long text more time than the configured timeout", async () => {
    await openaiTTS({ ...base, text: "x".repeat(4096), model: "gpt-realtime-2.1-mini" });
    expect(openaiRealtimeTTS.mock.calls[0]![0].timeoutMs).toBeGreaterThan(60_000);
    await openaiTTS({ ...base, timeoutMs: 120_000, model: "gpt-realtime-2.1-mini" });
    expect(openaiRealtimeTTS.mock.calls[1]![0].timeoutMs).toBe(120_000);
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

  it("skips the doomed request once a model is known to be retired", async () => {
    fetchMock.mockImplementation(async () => new Response(RETIRED_BODY, { status: 404 }));
    await openaiTTS({ ...base, model: "gpt-4o-mini-tts" });
    await openaiTTS({ ...base, model: "gpt-4o-mini-tts" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(openaiRealtimeTTS).toHaveBeenCalledTimes(2);
  });

  it("records one usage row per billed session", async () => {
    openaiRealtimeTTS.mockImplementation(
      async (_params: unknown, deps: { onSession?: (u: unknown) => void }) => {
        deps.onSession?.({ outputTokens: 100 });
        deps.onSession?.({ outputTokens: 120 });
        return { audio: Buffer.from("realtime"), usage: {}, attempts: 2, voice: "alloy" };
      },
    );
    await openaiTTS({ ...base, model: "gpt-realtime-2.1-mini" });
    expect(recordUsage).toHaveBeenCalledTimes(2);
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
    // A project whose model allowlist excludes the model gets "does not exist" too.
    fetchMock.mockResolvedValue(
      new Response(
        '{"error":{"code":"model_not_found","message":"The model `tts-1` does not exist or you do not have access to it."}}',
        { status: 404 },
      ),
    );
    await expect(openaiTTS({ ...base, model: "tts-1" })).rejects.toThrow(/\(404\)/);
    expect(openaiRealtimeTTS).not.toHaveBeenCalled();
  });

  it("keeps a legacy-only voice on the old model while it is served", async () => {
    fetchMock.mockResolvedValue(new Response(Buffer.from("legacy"), { status: 200 }));
    const audio = await openaiTTS({ ...base, voice: "nova", model: "gpt-realtime-2.1-mini" });
    expect(audio.toString()).toBe("legacy");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).toMatchObject({ model: "gpt-4o-mini-tts", voice: "nova" });
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({ model: "gpt-4o-mini-tts" });
    expect(openaiRealtimeTTS).not.toHaveBeenCalled();
  });

  it("moves a legacy-only voice to the realtime model after the shutdown", async () => {
    fetchMock.mockResolvedValue(new Response(RETIRED_BODY, { status: 404 }));
    await openaiTTS({ ...base, voice: "nova", model: "gpt-realtime-2.1-mini" });
    expect(openaiRealtimeTTS.mock.calls[0]![0]).toMatchObject({
      model: "gpt-realtime-2.1-mini",
      voice: "nova",
    });
    await openaiTTS({ ...base, voice: "nova", model: "gpt-realtime-2.1-mini" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never uses the Realtime API for a custom endpoint", async () => {
    process.env.OPENAI_TTS_BASE_URL = "http://localhost:8880/v1";
    fetchMock.mockImplementation(async () => new Response(Buffer.from("local"), { status: 200 }));
    const audio = await openaiTTS({ ...base, model: "gpt-realtime-2.1-mini" });
    expect(audio.toString()).toBe("local");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:8880/v1/audio/speech");
    // The default realtime name means nothing to Kokoro or LocalAI; they get the old default.
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).model).toBe("gpt-4o-mini-tts");
    await openaiTTS({ ...base, model: "kokoro" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).model).toBe("kokoro");
    fetchMock.mockImplementation(async () => new Response(RETIRED_BODY, { status: 404 }));
    await expect(openaiTTS({ ...base, model: "kokoro" })).rejects.toThrow(/\(404\)/);
    expect(openaiRealtimeTTS).not.toHaveBeenCalled();
  });
});

describe("isRetiredModelResponse", () => {
  const before = OPENAI_LEGACY_TTS_SHUTDOWN_MS - 1;
  const after = OPENAI_LEGACY_TTS_SHUTDOWN_MS + 1;
  const notFound =
    '{"error":{"code":"model_not_found","message":"The model `tts-1` does not exist or you do not have access to it."}}';

  it("accepts an explicit retirement notice at any time", () => {
    expect(isRetiredModelResponse(404, RETIRED_BODY, before)).toBe(true);
    expect(isRetiredModelResponse(410, "The model tts-1 has been shut down.", before)).toBe(true);
  });

  it("treats a bare model-not-found as retirement only after the shutdown date", () => {
    expect(isRetiredModelResponse(404, notFound, before)).toBe(false);
    expect(isRetiredModelResponse(404, notFound, after)).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isRetiredModelResponse(400, "Invalid voice", after)).toBe(false);
    expect(isRetiredModelResponse(400, "The `speed` parameter is deprecated", after)).toBe(false);
    expect(isRetiredModelResponse(500, RETIRED_BODY, after)).toBe(false);
  });
});
