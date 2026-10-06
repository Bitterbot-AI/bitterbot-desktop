import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chat-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { startVoiceSession, type VoicePhase } from "./voice-session";

let level = 0;
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(4000)], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
  paused = false;
  constructor(src: string) {
    this.src = src;
    playing.push(this);
  }
  play() {
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}
let playing: FakeAudio[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "performance"] });
  level = 0.002;
  calls.length = 0;
  playing = [];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal(
    "AudioContext",
    class {
      createAnalyser() {
        return {
          fftSize: 1024,
          getFloatTimeDomainData: (buf: Float32Array) => buf.fill(level),
        };
      }
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      close() {
        return Promise.resolve();
      }
    },
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
  });
  useChatStore.setState({ sessionKey: "agent:main:main", messages: [], activeRun: null });
  useGatewayStore.setState({
    status: "connected",
    request: (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "talk.transcribe") return { text: "book a table for two" };
      if (method === "talk.speak") return { audio: "AAAA", mimeType: "audio/mpeg" };
      return {};
    }) as never,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const speak = async (lvl: number, ms: number) => {
  level = lvl;
  await vi.advanceTimersByTimeAsync(ms);
};

describe("voice session", () => {
  it("hears a turn, sends it, speaks the reply as it streams, and stops on barge-in", async () => {
    const phases: VoicePhase[] = [];
    const session = await startVoiceSession((p) => phases.push(p));

    await speak(0.002, 600); // room
    await speak(0.3, 600); // "book a table for two"
    await speak(0.002, 1200); // pause ends the turn

    expect(calls.map((c) => c.method)).toContain("talk.transcribe");
    const send = calls.find((c) => c.method === "chat.send");
    expect(send?.params).toMatchObject({ message: "book a table for two" });
    const runId = String(send?.params.idempotencyKey);

    useChatStore
      .getState()
      .appendDelta(runId, "Your table at Nopa is booked for seven tonight. I also", 1);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.filter((c) => c.method === "talk.speak").map((c) => c.params.text)).toEqual([
      "Your table at Nopa is booked for seven tonight.",
    ]);
    expect(phases).toContain("speaking");

    // The owner talks over it: the voice stops and the run is aborted.
    await speak(0.6, 400);
    expect(playing.at(-1)?.paused).toBe(true);
    expect(calls.find((c) => c.method === "chat.abort")?.params).toMatchObject({ runId });

    session.stop();
    expect(phases.at(-1)).toBe("off");
  });
});
