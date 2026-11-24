import { beforeEach, describe, expect, it, vi } from "vitest";

const recordUsage = vi.fn();
vi.mock("../../../infra/usage-ledger.js", () => ({
  recordUsage: (...a: unknown[]) => recordUsage(...a),
}));

import { resolveModelPricing } from "../../../infra/model-pricing.js";
import { installPinnedHostnameTestHooks } from "../audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./audio.js";

installPinnedHostnameTestHooks();

const respond = (payload: unknown) => async () =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const run = (payload: unknown) =>
  transcribeOpenAiCompatibleAudio({
    buffer: Buffer.from("audio"),
    fileName: "note.ogg",
    apiKey: "test-key",
    timeoutMs: 1000,
    fetchFn: respond(payload),
  });

describe("transcription usage recording", () => {
  beforeEach(() => recordUsage.mockReset());

  it("defaults to gpt-transcribe", async () => {
    const result = await run({ text: "hi" });
    expect(result.model).toBe("gpt-transcribe");
  });

  it("stores seconds for duration-billed responses", async () => {
    await run({ text: "hi", usage: { type: "duration", seconds: 9 } });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      kind: "audio",
      provider: "openai",
      model: "gpt-transcribe",
      usage: { input: 9, total: 9 },
      items: 1,
    });
  });

  it("stores tokens for token-billed responses", async () => {
    await run({
      text: "hi",
      usage: { type: "tokens", input_tokens: 82, output_tokens: 26, total_tokens: 108 },
    });
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      usage: { input: 82, output: 26, total: 108 },
    });
  });

  it("ignores a malformed duration", async () => {
    await run({ text: "hi", usage: { type: "duration", seconds: "nine" } });
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      usage: { input: undefined, output: undefined, total: undefined },
    });
  });

  it("prices gpt-transcribe at $0.0045 per minute", async () => {
    const resolved = await resolveModelPricing({
      provider: "openai",
      model: "gpt-transcribe",
      kind: "audio",
    });
    // price.input is USD per 1M seconds; one minute = 60 seconds.
    expect((resolved.price.input * 60) / 1_000_000).toBeCloseTo(0.0045, 10);
  });
});
