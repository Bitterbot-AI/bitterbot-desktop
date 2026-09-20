import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  formatTruncatedToolText,
  resetToolResultSweepStateForTest,
  resolveToolResultMaxChars,
  resolveToolResultsDir,
  spillToolResultText,
  sweepToolResults,
  TOOL_RESULT_RETENTION_MS,
  wrapToolsWithResultSpill,
} from "./tool-result-spill.js";

let dir: string;
beforeEach(async () => {
  resetToolResultSweepStateForTest();
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tool-spill-"));
});
afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

function bigText(n: number): string {
  // Distinct head/tail so the round trip can be checked positionally.
  let out = "";
  let i = 0;
  while (out.length < n) {
    out += `line ${i++}\n`;
  }
  return out.slice(0, n);
}

describe("config + paths", () => {
  it("resultMaxChars defaults to 8000 and ignores values under 1000", () => {
    expect(resolveToolResultMaxChars(undefined)).toBe(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(resolveToolResultMaxChars({ tools: { resultMaxChars: 20000 } } as BitterbotConfig)).toBe(
      20000,
    );
    expect(resolveToolResultMaxChars({ tools: { resultMaxChars: 10 } } as BitterbotConfig)).toBe(
      8000,
    );
  });

  it("the spill dir is the sibling of the agent dir (~/.bitterbot/agents/<id>/tool-results)", () => {
    expect(resolveToolResultsDir("/state/agents/main/agent")).toBe(
      "/state/agents/main/tool-results",
    );
    expect(resolveToolResultsDir("/somewhere/else")).toBe("/somewhere/else/tool-results");
    expect(resolveToolResultsDir(undefined)).toBe(
      path.join(os.tmpdir(), "bitterbot", "tool-results"),
    );
  });
});

describe("formatTruncatedToolText", () => {
  it("head (75%) + one-line marker + tail (18.75%) with the saved path", () => {
    const text = bigText(20000);
    const out = formatTruncatedToolText({ text, maxChars: 8000, savedPath: "/p/run-1.txt" });
    const [head, marker, tail] = [
      out.slice(0, 6000),
      out.slice(6000).split("\n")[1],
      out.slice(out.length - 1500),
    ];
    expect(head).toBe(text.slice(0, 6000));
    expect(marker).toBe(
      "[truncated: 20000 chars total; full output saved to /p/run-1.txt; use read to view]",
    );
    expect(tail).toBe(text.slice(20000 - 1500));
    expect(out.length).toBeLessThan(8000);
  });

  it("never splits a surrogate pair at either cut", () => {
    const text = "😀".repeat(5000); // 10000 UTF-16 units
    const out = formatTruncatedToolText({ text, maxChars: 8000 });
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out).toContain("[truncated: 10000 chars total; full output not saved]");
  });
});

describe("spill round trip", () => {
  it("writes the FULL text to <dir>/<runId>-<n>.txt and returns head+marker+tail", async () => {
    const text = bigText(12345);
    const counter = { value: 0 };
    const first = await spillToolResultText(text, {
      maxChars: 8000,
      dir,
      runId: "run:abc/1",
      counter,
    });
    const second = await spillToolResultText(bigText(9000), {
      maxChars: 8000,
      dir,
      runId: "run:abc/1",
      counter,
    });
    expect(first.path).toBe(path.join(dir, "run_abc_1-1.txt"));
    expect(second.path).toBe(path.join(dir, "run_abc_1-2.txt"));
    expect(await fs.promises.readFile(first.path!, "utf8")).toBe(text);
    expect(first.text).toContain(`full output saved to ${first.path}; use read to view`);
    expect(first.text.startsWith(text.slice(0, 6000))).toBe(true);
    expect(first.text.endsWith(text.slice(12345 - 1500))).toBe(true);
    // Under the cap: untouched, no file.
    const small = await spillToolResultText("tiny", { maxChars: 8000, dir, runId: "x", counter });
    expect(small).toEqual({ text: "tiny" });
    expect(counter.value).toBe(2);
  });

  it("falls back to plain head/tail truncation when the file cannot be written", async () => {
    const blocked = path.join(dir, "not-a-dir");
    await fs.promises.writeFile(blocked, "file, not a dir");
    const out = await spillToolResultText(bigText(9000), {
      maxChars: 8000,
      dir: blocked,
      runId: "r",
    });
    expect(out.path).toBeUndefined();
    expect(out.text).toMatch(/\[truncated: 9000 chars total; full output not saved: /);
  });

  it("wrapToolsWithResultSpill caps only oversized text blocks, leaves images and details alone", async () => {
    const big = bigText(9000);
    const tool = {
      name: "exec",
      label: "exec",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        content: [
          { type: "text", text: "short" },
          { type: "text", text: big },
          { type: "image", data: "x".repeat(9000), mimeType: "image/png" },
        ],
        details: { aggregated: big },
      }),
    } as unknown as AnyAgentTool;
    const [wrapped] = wrapToolsWithResultSpill([tool], { maxChars: 8000, dir, runId: "run-1" });
    const result = (await wrapped!.execute("c", {})) as {
      content: Array<{ type: string; text?: string; data?: string }>;
      details: { aggregated: string };
    };
    expect(result.content[0]!.text).toBe("short");
    expect(result.content[1]!.text).toContain(
      "[truncated: 9000 chars total; full output saved to ",
    );
    expect(result.content[1]!.text!.length).toBeLessThan(8000);
    expect(result.content[2]!.data).toHaveLength(9000);
    expect(result.details.aggregated).toBe(big);
    const files = await fs.promises.readdir(dir);
    expect(files).toEqual(["run-1-1.txt"]);
    expect(await fs.promises.readFile(path.join(dir, files[0]!), "utf8")).toBe(big);
  });
});

describe("retention sweep", () => {
  it("removes .txt files older than 24h, keeps younger ones and non-txt entries", async () => {
    const old = path.join(dir, "old-1.txt");
    const young = path.join(dir, "young-1.txt");
    const other = path.join(dir, "keep.json");
    for (const p of [old, young, other]) {
      await fs.promises.writeFile(p, "x");
    }
    const past = new Date(Date.now() - TOOL_RESULT_RETENTION_MS - 60_000);
    await fs.promises.utimes(old, past, past);
    await fs.promises.utimes(other, past, past);
    expect(await sweepToolResults(dir)).toBe(1);
    expect((await fs.promises.readdir(dir)).toSorted()).toEqual(["keep.json", "young-1.txt"]);
    // Injectable clock: everything is stale from the far future.
    expect(await sweepToolResults(dir, { now: Date.now() + 2 * TOOL_RESULT_RETENTION_MS })).toBe(1);
    expect(await sweepToolResults(path.join(dir, "missing"))).toBe(0);
  });

  it("a spill triggers the sweep (at most once an hour per dir)", async () => {
    const old = path.join(dir, "stale-1.txt");
    await fs.promises.writeFile(old, "x");
    const past = new Date(Date.now() - TOOL_RESULT_RETENTION_MS - 60_000);
    await fs.promises.utimes(old, past, past);
    await spillToolResultText(bigText(9000), { maxChars: 8000, dir, runId: "r" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(old)).toBe(false);
  });
});
