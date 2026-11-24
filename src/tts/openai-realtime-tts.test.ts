import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  type RealtimeSocket,
  isFaithfulReadAloud,
  isOpenAIRealtimeTtsModel,
  openaiRealtimeTTS,
} from "./openai-realtime-tts.js";

type Script = (socket: FakeSocket, sent: Array<Record<string, unknown>>) => void;

class FakeSocket extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  constructor(private readonly script: Script) {
    super();
    queueMicrotask(() => this.emit("open"));
  }
  send(data: string) {
    const event = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(event);
    if (event.type === "response.create") {
      queueMicrotask(() => this.script(this, this.sent));
    }
  }
  close() {
    this.closed = true;
  }
  server(event: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
}

const speak =
  (transcript: string, pcm = Buffer.from([1, 2, 3, 4])): Script =>
  (socket) => {
    socket.server({ type: "response.output_audio_transcript.delta", delta: transcript });
    socket.server({ type: "response.output_audio.delta", delta: pcm.toString("base64") });
    socket.server({
      type: "response.done",
      response: {
        status: "completed",
        usage: { input_tokens: 71, output_tokens: 233, total_tokens: 304 },
      },
    });
  };

function harness(scripts: Script[]) {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const createSocket = (url: string, h: Record<string, string>) => {
    urls.push(url);
    headers.push(h);
    const socket = new FakeSocket(scripts[sockets.length] ?? scripts[scripts.length - 1]!);
    sockets.push(socket);
    return socket as unknown as RealtimeSocket;
  };
  const ensureEncoder = vi.fn(async () => {});
  const onSession = vi.fn();
  return { sockets, urls, headers, createSocket, ensureEncoder, onSession };
}

const TEXT = "The quarterly report is due on Friday. Please send the draft to Sylvia.";
const base = {
  text: TEXT,
  apiKey: "sk-test",
  model: "gpt-realtime-2.1-mini",
  voice: "alloy",
  timeoutMs: 2000,
};

describe("openaiRealtimeTTS", () => {
  it("returns raw PCM and sends the read-aloud session setup", async () => {
    const h = harness([speak(TEXT)]);
    const result = await openaiRealtimeTTS({ ...base, responseFormat: "pcm" }, h);
    expect(result.audio).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(result.attempts).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 71, outputTokens: 233, totalTokens: 304 });
    expect(h.urls[0]).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini");
    expect(h.headers[0]).toEqual({ Authorization: "Bearer sk-test" });

    const [session, item, create] = h.sockets[0]!.sent as Array<Record<string, any>>;
    expect(session!.type).toBe("session.update");
    expect(session!.session.instructions).toMatch(/exactly as written/);
    expect(session!.session.audio.output).toEqual({
      format: { type: "audio/pcm", rate: 24000 },
      voice: "alloy",
    });
    expect(item!.item.content).toEqual([{ type: "input_text", text: TEXT }]);
    expect(create!.type).toBe("response.create");
    expect(h.sockets[0]!.closed).toBe(true);
  });

  it("encodes to the requested format", async () => {
    const h = harness([speak(TEXT)]);
    const encode = vi.fn(async () => Buffer.from("ogg"));
    const result = await openaiRealtimeTTS({ ...base, responseFormat: "opus" }, { ...h, encode });
    expect(h.ensureEncoder).toHaveBeenCalledWith("opus");
    expect(encode).toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]), "opus", expect.any(Number));
    expect(result.audio.toString()).toBe("ogg");
  });

  it("checks the encoder before opening a billed session", async () => {
    const h = harness([speak(TEXT)]);
    h.ensureEncoder.mockRejectedValue(new Error("needs ffmpeg"));
    await expect(openaiRealtimeTTS({ ...base, responseFormat: "mp3" }, h)).rejects.toThrow(
      /needs ffmpeg/,
    );
    expect(h.sockets).toHaveLength(0);
    expect(h.onSession).not.toHaveBeenCalled();
  });

  it("needs no encoder for PCM", async () => {
    const h = harness([speak(TEXT)]);
    await openaiRealtimeTTS({ ...base, responseFormat: "pcm" }, h);
    expect(h.ensureEncoder).not.toHaveBeenCalled();
  });

  it("reports every completed session, including a rejected one", async () => {
    const h = harness([speak("Sure! Here is a summary instead."), speak(TEXT)]);
    await openaiRealtimeTTS({ ...base, responseFormat: "pcm" }, h);
    expect(h.onSession).toHaveBeenCalledTimes(2);
    expect(h.onSession.mock.calls[0]![0]).toEqual({
      inputTokens: 71,
      outputTokens: 233,
      totalTokens: 304,
    });
  });

  it("substitutes a Realtime voice for a legacy-only one", async () => {
    const h = harness([speak(TEXT)]);
    const result = await openaiRealtimeTTS({ ...base, voice: "nova", responseFormat: "pcm" }, h);
    expect(result.voice).toBe("marin");
    const session = h.sockets[0]!.sent[0] as Record<string, any>;
    expect(session.session.audio.output.voice).toBe("marin");
  });

  it("ignores messages that arrive after the session settled", async () => {
    const h = harness([speak(TEXT)]);
    const result = await openaiRealtimeTTS({ ...base, responseFormat: "pcm" }, h);
    h.sockets[0]!.server({ type: "response.output_audio.delta", delta: "AAAA" });
    expect(result.audio).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("retries once when the model answers instead of reading", async () => {
    const h = harness([speak("Got it! I can't send messages, but here is a plan."), speak(TEXT)]);
    const result = await openaiRealtimeTTS({ ...base, responseFormat: "pcm" }, h);
    expect(result.attempts).toBe(2);
    expect(h.sockets).toHaveLength(2);
  });

  it("fails after two unfaithful attempts", async () => {
    const h = harness([speak("The quarterly report is due on Friday.")]);
    await expect(openaiRealtimeTTS({ ...base, responseFormat: "pcm" }, h)).rejects.toThrow(
      /did not read the text as written after 2 attempts/,
    );
  });

  it("rejects unknown voices before connecting", async () => {
    const h = harness([speak(TEXT)]);
    await expect(
      openaiRealtimeTTS({ ...base, voice: "zzz", responseFormat: "pcm" }, h),
    ).rejects.toThrow(/Voice "zzz" is not available/);
    expect(h.sockets).toHaveLength(0);
  });

  it("surfaces API error events", async () => {
    const h = harness([(s) => s.server({ type: "error", error: { message: "bad session" } })]);
    await expect(openaiRealtimeTTS({ ...base, responseFormat: "pcm" }, h)).rejects.toThrow(
      /OpenAI Realtime API error: bad session/,
    );
  });

  it("fails on a response that did not complete", async () => {
    const h = harness([
      (s) => s.server({ type: "response.done", response: { status: "incomplete" } }),
    ]);
    await expect(openaiRealtimeTTS({ ...base, responseFormat: "pcm" }, h)).rejects.toThrow(
      /status incomplete/,
    );
  });

  it("fails on a rejected handshake and an early close", async () => {
    const rejected = harness([(s) => s.emit("unexpected-response", {}, { statusCode: 401 })]);
    await expect(openaiRealtimeTTS({ ...base, responseFormat: "pcm" }, rejected)).rejects.toThrow(
      /\(401\)/,
    );
    const dropped = harness([(s) => s.emit("close")]);
    await expect(openaiRealtimeTTS({ ...base, responseFormat: "pcm" }, dropped)).rejects.toThrow(
      /closed early/,
    );
  });

  it("times out as an AbortError when the session never finishes", async () => {
    const h = harness([() => {}]);
    await expect(
      openaiRealtimeTTS({ ...base, timeoutMs: 30, responseFormat: "pcm" }, h),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(h.sockets[0]!.closed).toBe(true);
  });
});

describe("isFaithfulReadAloud", () => {
  const same = (text: string) => expect(isFaithfulReadAloud(text, text)).toBe(true);

  it("accepts what the model actually returns for ordinary replies", () => {
    // Transcripts measured against the live API echo the input text.
    for (const text of [
      "OK",
      "Yes.",
      "I have 3 apples",
      "Meet at 3pm",
      "That costs $4.50 total",
      "It is state-of-the-art",
      "Done—shipped",
      "e.g. this works",
      "Dr. Smith arrives at 10:30",
      "v1.14.1 is live",
      "你好，世界。今天天气很好",
      "今天我们讨论 OpenAI 的 API 更新",
      "Hola, ¿cómo estás? Nos vemos mañana.",
    ]) {
      same(text);
    }
  });

  it("ignores punctuation, case, spacing and markdown markers", () => {
    expect(isFaithfulReadAloud("Hello, world! It's 2:30 p.m.", "hello world its 2:30 PM")).toBe(
      true,
    );
    expect(isFaithfulReadAloud("It is state-of-the-art", "It is state of the art")).toBe(true);
    expect(isFaithfulReadAloud("**Done.** Check `config.json`.", "Done. Check config.json.")).toBe(
      true,
    );
    expect(isFaithfulReadAloud("你好，世界。今天天气很好", "你好， 世界。 今天天气很好")).toBe(
      true,
    );
  });

  it("accepts a spelled-out URL", () => {
    expect(
      isFaithfulReadAloud(
        "See https://example.com/docs for more",
        "See example dot com slash docs for more",
      ),
    ).toBe(true);
    expect(isFaithfulReadAloud("https://example.com", "example dot com")).toBe(true);
  });

  it("rejects a dropped passage", () => {
    const sentence = "The relay in Frankfurt was updated overnight and the wallet is unchanged. ";
    const source = sentence.repeat(4) + "Second, Sylvia asked whether the installer works.";
    expect(isFaithfulReadAloud(source, sentence.repeat(4))).toBe(false);
    expect(
      isFaithfulReadAloud(
        source,
        sentence.repeat(3) + "Second, Sylvia asked whether the installer works.",
      ),
    ).toBe(false);
  });

  it("rejects a conversational answer and added commentary", () => {
    expect(isFaithfulReadAloud("What is the capital of France?", "The capital is Paris.")).toBe(
      false,
    );
    expect(isFaithfulReadAloud("Send it", "Do not send it")).toBe(false);
    expect(isFaithfulReadAloud("Yes", "Yes I agree")).toBe(false);
    expect(
      isFaithfulReadAloud(
        "Send the draft today.",
        "Send the draft today. Sure, I can also help you write it if you want me to.",
      ),
    ).toBe(false);
  });

  it("rejects the same words in a different order", () => {
    expect(
      isFaithfulReadAloud(
        "Pay Alice first and then refund Bob afterwards",
        "Refund Bob first and then pay Alice afterwards",
      ),
    ).toBe(false);
  });

  it("bounds what can be said for text with nothing speakable", () => {
    expect(isFaithfulReadAloud("👍", "thumbs up")).toBe(true);
    expect(isFaithfulReadAloud("👍", "")).toBe(true);
    expect(
      isFaithfulReadAloud("👍", "Great, glad that works for you! Anything else I can help with?"),
    ).toBe(false);
    expect(isFaithfulReadAloud("Hello there", "")).toBe(false);
  });

  it("stays fast on the longest text the caller sends", () => {
    const a = "The quick brown fox jumps over the lazy dog. ".repeat(95).slice(0, 4096);
    const b = a.replace(/quick/g, "slow");
    const started = Date.now();
    isFaithfulReadAloud(a, b);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("isOpenAIRealtimeTtsModel", () => {
  it("knows the replacement model only", () => {
    expect(isOpenAIRealtimeTtsModel("gpt-realtime-2.1-mini")).toBe(true);
    expect(isOpenAIRealtimeTtsModel("gpt-4o-mini-tts")).toBe(false);
  });
});
