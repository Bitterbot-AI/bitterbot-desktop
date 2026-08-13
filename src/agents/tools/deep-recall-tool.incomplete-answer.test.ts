/**
 * A capped deep_recall run must not read as a success.
 *
 * Real incident (2026-08-13): a two-step continuity probe asked the sandbox to
 * `store("continuity_token", "violet-owl-42")`. Step 1 hit the 16-iteration cap
 * and returned `success: false, limitReached: "iterations"` — but its `answer`
 * was the last REPL scrap, which read "Task: store marker + confirm — COMPLETE.
 * FINAL already called." Nothing was ever written to the durable store. The
 * agent relayed "stored" to the operator, step 2 found nothing, and the miss was
 * filed as a curiosity blind spot rather than a defect.
 */
import { describe, expect, it } from "vitest";
import { annotateIncompleteAnswer } from "./deep-recall-tool.js";

describe("annotateIncompleteAnswer", () => {
  it("leaves a genuine success untouched", () => {
    expect(annotateIncompleteAnswer("the answer", true, null)).toBe("the answer");
    expect(annotateIncompleteAnswer("the answer", true, undefined)).toBe("the answer");
  });

  it("marks the exact shape that misled the operator", () => {
    const out = annotateIncompleteAnswer(
      "continuity_token = violet-owl-42 Task: store marker + confirm — COMPLETE. FINAL already called.",
      false,
      "iterations",
    );
    expect(out).toContain("INCOMPLETE");
    expect(out).toContain("ran out of iterations");
    expect(out).toContain("NOT a confirmed outcome");
    // The original text is preserved for debugging, just no longer standalone.
    expect(out).toContain("violet-owl-42");
    expect(out!.indexOf("INCOMPLETE")).toBeLessThan(out!.indexOf("COMPLETE. FINAL"));
  });

  it("annotates every limit kind, and plain failures too", () => {
    for (const [limit, phrase] of [
      ["budget", "ran out of budget"],
      ["sub_calls", "ran out of sub-calls"],
      ["timeout", "timed out"],
    ] as const) {
      expect(annotateIncompleteAnswer("x", false, limit)).toContain(phrase);
    }
    expect(annotateIncompleteAnswer("x", false, null)).toContain("it failed");
  });

  it("still says something when the run produced no answer at all", () => {
    const out = annotateIncompleteAnswer(null, false, "iterations");
    expect(out).toContain("INCOMPLETE");
  });

  it("annotates a run that reports success but also hit a limit", () => {
    // Defensive: success + limitReached is contradictory, so treat it as suspect.
    expect(annotateIncompleteAnswer("done", true, "iterations")).toContain("INCOMPLETE");
  });
});
