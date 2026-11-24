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
  return { sockets, urls, headers, createSocket };
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
    expect(encode).toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]), "opus");
    expect(result.audio.toString()).toBe("ogg");
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

  it("rejects voices the Realtime API does not offer before connecting", async () => {
    const h = harness([speak(TEXT)]);
    await expect(
      openaiRealtimeTTS({ ...base, voice: "nova", responseFormat: "pcm" }, h),
    ).rejects.toThrow(/Voice "nova" is not available/);
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
  it("accepts the same words with different punctuation and case", () => {
    expect(isFaithfulReadAloud("Hello, world! It's 2:30 p.m.", "hello world its 2:30 PM")).toBe(
      true,
    );
  });

  it("rejects a dropped passage", () => {
    const sentence = "The relay in Frankfurt was updated overnight and the wallet is unchanged. ";
    const source = sentence + "Second, Sylvia asked whether the installer works on Ubuntu.";
    expect(isFaithfulReadAloud(source, sentence)).toBe(false);
  });

  it("rejects a conversational answer and added commentary", () => {
    expect(isFaithfulReadAloud("What is the capital of France?", "The capital is Paris.")).toBe(
      false,
    );
    expect(
      isFaithfulReadAloud(
        "Send the draft today.",
        "Send the draft today. Sure, I can also help you write it if you want me to.",
      ),
    ).toBe(false);
  });

  it("rejects empty speech but accepts text with nothing speakable", () => {
    expect(isFaithfulReadAloud("Hello there", "")).toBe(false);
    expect(isFaithfulReadAloud("🎉 !!!", "")).toBe(true);
  });

  it("handles scripts written without spaces", () => {
    const zh = "今天的会议改到下午三点，请提前十分钟到达会议室。";
    expect(isFaithfulReadAloud(zh, "今天的会议改到下午三点请提前十分钟到达会议室")).toBe(true);
    expect(isFaithfulReadAloud(zh, "今天的会议改到下午三点")).toBe(false);
  });
});

describe("isOpenAIRealtimeTtsModel", () => {
  it("knows the replacement model only", () => {
    expect(isOpenAIRealtimeTtsModel("gpt-realtime-2.1-mini")).toBe(true);
    expect(isOpenAIRealtimeTtsModel("gpt-4o-mini-tts")).toBe(false);
  });
});
