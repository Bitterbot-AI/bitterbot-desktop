import { describe, expect, it } from "vitest";
import { speakable, takeSentences } from "./sentences";
import { createVad, rms } from "./vad";

const feed = (vad: ReturnType<typeof createVad>, level: number, fromMs: number, toMs: number) => {
  const events: Array<{ at: number; e: string }> = [];
  for (let t = fromMs; t <= toMs; t += 20) {
    const e = vad.process(level, t);
    if (e) events.push({ at: t, e });
  }
  return events;
};

describe("voice activity detection", () => {
  it("starts on sustained speech and ends after a pause", () => {
    const vad = createVad();
    feed(vad, 0.005, 0, 1000); // room noise
    const start = feed(vad, 0.2, 1020, 1500);
    expect(start[0]).toEqual({ at: 1140, e: "speech-start" });
    const end = feed(vad, 0.005, 1520, 3000);
    expect(end[0]?.e).toBe("speech-end");
    expect(end[0]!.at - 1520).toBeGreaterThanOrEqual(900);
  });

  it("ignores a click and a steady fan", () => {
    const vad = createVad();
    expect(feed(vad, 0.3, 0, 60)).toEqual([]);
    expect(feed(vad, 0.006, 80, 5000)).toEqual([]);
  });

  it("needs a louder voice while the agent is speaking", () => {
    const vad = createVad();
    feed(vad, 0.005, 0, 1000);
    vad.setSensitivity(4);
    expect(feed(vad, 0.04, 1020, 2000)).toEqual([]);
    expect(feed(vad, 0.3, 2020, 2400)[0]?.e).toBe("speech-start");
  });

  it("measures loudness", () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array())).toBe(0);
  });
});

describe("speaking a streamed reply", () => {
  it("hands over whole sentences and keeps the unfinished one", () => {
    const { sentences, rest } = takeSentences(
      "Your table at Nopa is booked for 7:30 tonight. I also added it to your calendar and set a rem",
    );
    expect(sentences).toEqual(["Your table at Nopa is booked for 7:30 tonight."]);
    expect(rest.trim()).toBe("I also added it to your calendar and set a rem");
  });

  it("joins short pieces and does not split 7.30 or e.g. mid-number", () => {
    const { sentences } = takeSentences(
      "Done. Booked for 7.30 at the usual place, see you there. ",
    );
    expect(sentences).toEqual(["Done. Booked for 7.30 at the usual place, see you there."]);
  });

  it("holds an open code block and reads markdown as words", () => {
    const { sentences, rest } = takeSentences(
      "Here is the script you asked for today:\n\n```py\nprint(1)",
    );
    expect(sentences).toEqual(["Here is the script you asked for today:"]);
    expect(rest).toContain("```py");
    expect(speakable("**Bold** and [a link](https://x.y) plus `code`.")).toBe(
      "Bold and a link plus code.",
    );
  });
});
