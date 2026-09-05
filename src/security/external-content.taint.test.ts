import { describe, expect, it } from "vitest";
import {
  evidenceTouchesUntrusted,
  findExternalUntrustedLineRanges,
  wrapExternalContent,
} from "./external-content.js";

describe("external-content taint ranges (B7)", () => {
  it("finds every envelope as a 1-based inclusive line range", () => {
    const wrapped = wrapExternalContent("line a\nline b", { source: "email", sender: "x@y.z" });
    const text = ["user: check this", ...wrapped.split("\n"), "assistant: ok", "user: fine"].join(
      "\n",
    );
    const ranges = findExternalUntrustedLineRanges(text);
    expect(ranges).toHaveLength(1);
    const lines = text.split("\n");
    // 1-based: the START marker line opens the range, the END marker closes it.
    expect(lines[ranges[0]!.start - 1]).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(lines[ranges[0]!.end - 1]).toContain("<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(ranges[0]!.start).toBeGreaterThan(1);
    expect(ranges[0]!.end).toBeLessThan(lines.length);
    expect(findExternalUntrustedLineRanges("no envelope here")).toEqual([]);
  });

  it("an unterminated envelope runs to the end of the text (fail closed)", () => {
    const ranges = findExternalUntrustedLineRanges("a\n<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nb\nc");
    expect(ranges).toEqual([{ start: 2, end: 4 }]);
  });

  it("facts keep the taint when their evidence lies inside an envelope or cites nothing", () => {
    const ranges = [{ start: 5, end: 9 }];
    expect(evidenceTouchesUntrusted([2, 3], ranges)).toBe(false);
    expect(evidenceTouchesUntrusted([2, 7], ranges)).toBe(true);
    expect(evidenceTouchesUntrusted([], ranges)).toBe(true);
    expect(evidenceTouchesUntrusted([], [])).toBe(false);
    expect(evidenceTouchesUntrusted([7], [])).toBe(false);
  });
});
