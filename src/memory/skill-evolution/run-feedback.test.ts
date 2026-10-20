import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendRunFeedback,
  isValidRunId,
  readRunFeedback,
  runFeedbackPath,
} from "./run-feedback.js";

describe("run feedback ledger (B8)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-feedback-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("appends explicit verdicts and the newest per run wins", async () => {
    const opts = { configDir: dir };
    expect(await readRunFeedback(opts)).toEqual(new Map());
    await appendRunFeedback(
      { runId: "run-1", verdict: "rejected", note: "wrong date", by: "victor" },
      opts,
    );
    await appendRunFeedback({ runId: "run-2", verdict: "confirmed" }, opts);
    await appendRunFeedback({ runId: "run-1", verdict: "confirmed", note: "fixed on retry" }, opts);
    const map = await readRunFeedback(opts);
    expect(map.get("run-1")).toMatchObject({
      verdict: "confirmed",
      note: "fixed on retry",
      by: "operator",
    });
    expect(map.get("run-2")).toMatchObject({ verdict: "confirmed", note: null, by: "operator" });
    const raw = await fs.readFile(runFeedbackPath(opts), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(3);
  });

  it("refuses malformed run ids and verdicts, caps notes, and skips corrupt lines", async () => {
    const opts = { configDir: dir };
    await expect(
      appendRunFeedback({ runId: "bad id!", verdict: "confirmed" }, opts),
    ).rejects.toThrow(/invalid run id/);
    await expect(
      appendRunFeedback({ runId: "run-1", verdict: "meh" as never }, opts),
    ).rejects.toThrow(/verdict/);
    const entry = await appendRunFeedback(
      { runId: "run-1", verdict: "rejected", note: "x".repeat(900) },
      opts,
    );
    expect(entry.note?.length).toBe(500);
    await fs.appendFile(runFeedbackPath(opts), "{not json\n", "utf-8");
    await fs.appendFile(
      runFeedbackPath(opts),
      `${JSON.stringify({ runId: "run-3", verdict: "nonsense" })}\n`,
      "utf-8",
    );
    const map = await readRunFeedback(opts);
    expect([...map.keys()]).toEqual(["run-1"]);
    expect(isValidRunId("task:abc")).toBe(true);
    expect(isValidRunId("")).toBe(false);
  });
});
