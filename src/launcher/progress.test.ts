import { describe, expect, it } from "vitest";
import {
  createDefaultLauncherOutput,
  createLauncherOutput,
  formatMegabytes,
  tildify,
} from "./progress.js";

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

describe("output when stderr is captured (the 1.6.x updater's completion step)", () => {
  it("mirrors to the terminal (/dev/tty) so a first-run download is visible, opened lazily", () => {
    const stderr = sink(false);
    const tty: string[] = [];
    let opened = 0;
    const out = createDefaultLauncherOutput({
      stderr: stderr.stream,
      platform: "darwin",
      openTty: () => {
        opened += 1;
        return 9;
      },
      writeFd: (fd, chunk) => {
        expect(fd).toBe(9);
        tty.push(chunk);
      },
    });
    expect(opened).toBe(0);
    out.say("Bitterbot 1.6.2: first run, downloading the signed release (410 MB)...");
    out.progress(205_000_000, 410_000_000);
    out.say("Verified and installed to ~/.bitterbot/app/1.6.2.");
    expect(opened).toBe(1);
    expect(stderr.chunks.join("")).toContain("Verified and installed");
    expect(tty.join("")).toContain("first run, downloading");
    expect(tty.join("")).toMatch(/\r {2}\[#{12}-{12}\] {2}50%/);
  });

  it("keeps plain stderr lines when there is no terminal (a service)", () => {
    const stderr = sink(false);
    const out = createDefaultLauncherOutput({
      stderr: stderr.stream,
      platform: "linux",
      openTty: () => {
        throw Object.assign(new Error("no tty"), { code: "ENXIO" });
      },
    });
    out.say("hello");
    expect(stderr.chunks).toEqual(["hello\n"]);
  });

  it("uses stderr alone when it is a terminal", () => {
    const stderr = sink(true);
    let opened = false;
    const out = createDefaultLauncherOutput({
      stderr: stderr.stream,
      platform: "linux",
      openTty: () => {
        opened = true;
        return 1;
      },
    });
    out.say("hi");
    expect(opened).toBe(false);
  });
});
