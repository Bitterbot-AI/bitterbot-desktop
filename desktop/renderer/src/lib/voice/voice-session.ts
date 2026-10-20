/**
 * Voice mode for the Control UI (PLAN-53 F3, step one: cascaded).
 *
 *   listen -> you speak -> recorded -> talk.transcribe -> chat.send
 *   -> the reply streams in -> spoken sentence by sentence (talk.speak)
 *   -> listen again.
 *
 * Talking over the agent stops its voice and aborts the run (barge-in).
 * Nothing leaves the machine except through the gateway's own speech
 * providers.
 */

import { useChatStore } from "../../stores/chat-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { sendChatText } from "../chat-send";
import { takeSentences, speakable } from "./sentences";
import { createVad, rms } from "./vad";

export type VoicePhase = "off" | "listening" | "hearing" | "thinking" | "speaking" | "error";

export type VoiceSession = { stop: () => void };

const FRAME_MS = 30;
/** While the agent talks, you need to be this much louder to cut in. */
const BARGE_IN_SENSITIVITY = 2.5;

function pickMimeType(): string {
  for (const t of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function startVoiceSession(onPhase: (p: VoicePhase, detail?: string) => void) {
  const request = useGatewayStore.getState().request;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const vad = createVad();
  const mimeType = pickMimeType();

  let stopped = false;
  let recorder: MediaRecorder | null = null;
  // Speaking state.
  const queue: string[] = [];
  let audio: HTMLAudioElement | null = null;
  let speakingRunId: string | null = null;
  let spokenChars = 0;
  let generation = 0;

  const setPhase = (p: VoicePhase, detail?: string) => {
    if (!stopped) onPhase(p, detail);
  };

  const stopSpeaking = () => {
    generation++;
    queue.length = 0;
    if (audio) {
      audio.pause();
      audio.src = "";
      audio = null;
    }
    vad.setSensitivity(1);
  };

  const playNext = async () => {
    if (audio || queue.length === 0 || stopped) return;
    const gen = generation;
    const sentence = queue.shift()!;
    vad.setSensitivity(BARGE_IN_SENSITIVITY);
    setPhase("speaking");
    try {
      const res = (await request("talk.speak", { text: sentence })) as {
        audio: string;
        mimeType: string;
      };
      if (gen !== generation || stopped) return;
      audio = new Audio(`data:${res.mimeType};base64,${res.audio}`);
      await new Promise<void>((resolve) => {
        audio!.addEventListener("ended", () => resolve(), { once: true });
        audio!.addEventListener("error", () => resolve(), { once: true });
        void audio!.play().catch(() => resolve());
      });
    } catch (err) {
      setPhase("error", err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === generation) {
        audio = null;
        if (queue.length > 0) {
          void playNext();
        } else if (!useChatStore.getState().activeRun) {
          vad.setSensitivity(1);
          setPhase("listening");
        }
      }
    }
  };

  // Follow the reply as it streams and queue whole sentences.
  const unsubscribeChat = useChatStore.subscribe((s, prev) => {
    if (!speakingRunId) return;
    const run = s.activeRun;
    if (run && run.runId === speakingRunId) {
      const { sentences, rest } = takeSentences(run.text.slice(spokenChars));
      if (sentences.length > 0) {
        spokenChars = run.text.length - rest.length;
        queue.push(...sentences);
        void playNext();
      }
      return;
    }
    if (prev.activeRun?.runId === speakingRunId && !run) {
      // The run finished: speak what is left of the final reply.
      const last = [...s.messages].toReversed().find((m) => m.role === "assistant");
      const tail = last ? speakable(last.content.slice(spokenChars)) : "";
      speakingRunId = null;
      if (tail) {
        queue.push(tail);
        void playNext();
      } else if (!audio && queue.length === 0) {
        setPhase("listening");
      }
    }
  });

  const onUtterance = async (blob: Blob) => {
    if (blob.size < 2000) {
      setPhase("listening");
      return;
    }
    setPhase("thinking");
    try {
      const res = (await request("talk.transcribe", {
        audio: await blobToBase64(blob),
        mimeType: blob.type || mimeType || "audio/webm",
      })) as { text: string };
      if (stopped) return;
      spokenChars = 0;
      speakingRunId = await sendChatText(res.text);
      if (!speakingRunId) setPhase("listening");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Nothing recognized is not an error worth showing; just listen again.
      setPhase(message.includes("no speech") ? "listening" : "error", message);
    }
  };

  const bargeIn = async () => {
    const run = useChatStore.getState().activeRun;
    stopSpeaking();
    speakingRunId = null;
    if (run) {
      const sessionKey = useChatStore.getState().sessionKey;
      await request("chat.abort", { sessionKey, runId: run.runId }).catch(() => {});
    }
  };

  const tick = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    const event = vad.process(rms(samples), performance.now());
    if (event === "speech-start") {
      if (audio || queue.length > 0 || speakingRunId) void bargeIn();
      const parts: Blob[] = [];
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) parts.push(e.data);
      };
      rec.onstop = () => void onUtterance(new Blob(parts, { type: rec.mimeType }));
      rec.start();
      recorder = rec;
      setPhase("hearing");
    } else if (event === "speech-end" && recorder?.state === "recording") {
      recorder.stop();
    }
  };
  const timer = window.setInterval(tick, FRAME_MS);
  setPhase("listening");
  void request("talk.mode", { enabled: true, phase: "listening" }).catch(() => {});

  return {
    stop: () => {
      stopped = true;
      window.clearInterval(timer);
      unsubscribeChat();
      stopSpeaking();
      if (recorder?.state === "recording") {
        recorder.onstop = null;
        recorder.stop();
      }
      for (const track of stream.getTracks()) track.stop();
      void ctx.close();
      void request("talk.mode", { enabled: false }).catch(() => {});
      onPhase("off");
    },
  } satisfies VoiceSession;
}
