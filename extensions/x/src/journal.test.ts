import { describe, expect, it } from "vitest";
import { buildJournalCronParams, buildJournalPrompt, parseEveryMs } from "./journal.js";

describe("journal", () => {
  it("parses durations", () => {
    expect(parseEveryMs("4h")).toBe(14_400_000);
    expect(parseEveryMs("90m")).toBe(5_400_000);
    expect(() => parseEveryMs("10s")).toThrow(/at least 1m/);
    expect(() => parseEveryMs("soon")).toThrow(/invalid duration/);
  });

  it("builds an isolated agentTurn job with delivery none", () => {
    const params = buildJournalCronParams({ every: "4h", handle: "bitterbot_ai" });
    expect(params.schedule).toEqual({ kind: "every", everyMs: 14_400_000 });
    expect(params.sessionTarget).toBe("isolated");
    expect(params.payload.kind).toBe("agentTurn");
    expect(params.delivery).toEqual({ mode: "none" });
    expect(params.noDeliver).toBe(true);
    expect(params.payload.message).toContain("@bitterbot_ai");
    expect(buildJournalPrompt({})).toMatch(/NO_POST/);
  });
});
