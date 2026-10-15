import { describe, expect, it } from "vitest";
import { createLauncherOutput, formatMegabytes, tildify } from "./progress.js";

function sink(isTTY: boolean) {
  const chunks: string[] = [];
  return { chunks, stream: { isTTY, write: (c: string) => chunks.push(c) } };
}

describe("launcher output", () => {
  it("prints a plain line every 25% when not a terminal", () => {
    const { chunks, stream } = sink(false);
    const out = createLauncherOutput(stream);
    const total = 400_000_000;
    for (let r = 0; r <= total; r += 10_000_000) {
      out.progress(r, total);
    }
    expect(chunks).toEqual([
      "  25% (100 MB of 400 MB)\n",
      "  50% (200 MB of 400 MB)\n",
      "  75% (300 MB of 400 MB)\n",
    ]);
  });

  it("draws one self-updating bar on a terminal and closes it before the next line", () => {
    const { chunks, stream } = sink(true);
    let t = 0;
    const out = createLauncherOutput(stream, () => t);
    out.progress(0, 410_000_000);
    t += 50;
    out.progress(1_000_000, 410_000_000); // throttled
    t += 100;
    out.progress(205_000_000, 410_000_000);
    out.say("Verified.");
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toMatch(/^\r {2}\[-{24}\] {3}0% {2}1 MB \/ 410 MB/);
    expect(chunks[1]).toMatch(/^\r {2}\[#{12}-{12}\] {2}50% {2}205 MB \/ 410 MB/);
    expect(chunks[2]).toBe("\n");
    expect(chunks[3]).toBe("Verified.\n");
  });

  it("formats sizes and home paths", () => {
    expect(formatMegabytes(409_600_000)).toBe("410 MB");
    expect(formatMegabytes(10)).toBe("1 MB");
    expect(tildify("/home/u/.bitterbot/app/1.6.2", "/home/u")).toBe("~/.bitterbot/app/1.6.2");
    expect(tildify("/opt/bitterbot", "/home/u")).toBe("/opt/bitterbot");
  });
});
