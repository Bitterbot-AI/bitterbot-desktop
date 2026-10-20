import { describe, expect, it } from "vitest";
import { extractSessionFacts } from "./session-extractor.js";
import {
  isHeartbeatAckText,
  isHeartbeatPromptText,
  remapLine,
  stripHeartbeatTurns,
  windowTranscript,
} from "./session-transcript-prep.js";

const HB_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";

function heartbeatPairs(n: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(`User: ${HB_PROMPT}`, "Assistant: HEARTBEAT_OK");
  }
  return lines;
}

describe("heartbeat detection", () => {
  it("recognises the default heartbeat prompt and bare acks", () => {
    expect(isHeartbeatPromptText(HB_PROMPT)).toBe(true);
    expect(isHeartbeatPromptText("please read HEARTBEAT.md and tell me what it says")).toBe(false);
    expect(isHeartbeatAckText("HEARTBEAT_OK")).toBe(true);
    expect(isHeartbeatAckText("HEARTBEAT_OK.")).toBe(true);
    expect(isHeartbeatAckText("HEARTBEAT_OKAY, moving on")).toBe(false);
    expect(isHeartbeatAckText("Alert: disk at 95%")).toBe(false);
  });
});

describe("stripHeartbeatTurns", () => {
  it("drops prompt/ack pairs and maps surviving lines back to the original", () => {
    const lines = [
      "User: hello, let's fix the deploy",
      "Assistant: sure",
      "continuation of the assistant turn",
      ...heartbeatPairs(2),
      "User: the gateway is a2a.new.example now",
      "Assistant: noted",
    ];
    const out = stripHeartbeatTurns(lines.join("\n"));
    expect(out.droppedTurns).toBe(4);
    expect(out.content.split("\n")).toEqual([
      "User: hello, let's fix the deploy",
      "Assistant: sure",
      "continuation of the assistant turn",
      "User: the gateway is a2a.new.example now",
      "Assistant: noted",
    ]);
    // Filtered line 4 is original line 8.
    expect(out.lineMap).toEqual([1, 2, 3, 8, 9]);
    expect(remapLine(out.lineMap, 4)).toBe(8);
  });

  it("keeps an alert reply that is not a bare ack", () => {
    const out = stripHeartbeatTurns(
      [`User: ${HB_PROMPT}`, "Assistant: Alert: build failed on main", "User: thanks"].join("\n"),
    );
    expect(out.droppedTurns).toBe(1);
    expect(out.content.split("\n")).toEqual([
      "Assistant: Alert: build failed on main",
      "User: thanks",
    ]);
  });

  it("a heartbeat-only transcript becomes empty", () => {
    const out = stripHeartbeatTurns(heartbeatPairs(48).join("\n"));
    expect(out.content).toBe("");
    expect(out.droppedTurns).toBe(96);
  });

  it("is a no-op (identity line map) without heartbeats", () => {
    const out = stripHeartbeatTurns("User: a\nAssistant: b");
    expect(out.droppedTurns).toBe(0);
    expect(out.lineMap).toEqual([1, 2]);
  });
});

describe("windowTranscript", () => {
  it("splits at turn boundaries and preserves original line numbers", () => {
    const prepared = stripHeartbeatTurns(
      [
        "User: " + "a".repeat(30),
        "Assistant: " + "b".repeat(30),
        "more b",
        "User: " + "c".repeat(30),
        "Assistant: " + "d".repeat(30),
      ].join("\n"),
    );
    const windows = windowTranscript(prepared, 90);
    expect(windows.length).toBe(2);
    expect(windows[0]!.lineMap).toEqual([1, 2, 3]);
    expect(windows[1]!.lineMap).toEqual([4, 5]);
    expect(windows[1]!.content.startsWith("User: ccc")).toBe(true);
  });

  it("returns a single window when under the threshold", () => {
    const prepared = stripHeartbeatTurns("User: a\nAssistant: b");
    expect(windowTranscript(prepared, 48_000).length).toBe(1);
  });
});

describe("extractSessionFacts with heartbeat stripping and windowing", () => {
  const facts = (line: number) =>
    JSON.stringify({
      facts: [{ text: `fact from L${line}`, layer: "world_fact", confidence: 0.9, lines: [line] }],
      handover: {
        purpose: "work",
        milestones: [`m${line}`],
        decisions: [],
        blockers: [],
        nextSteps: ["n"],
      },
    });

  it("makes no LLM call for a heartbeat-only transcript", async () => {
    let calls = 0;
    const result = await extractSessionFacts(heartbeatPairs(48).join("\n"), "s", async () => {
      calls++;
      return facts(1);
    });
    expect(calls).toBe(0);
    expect(result).toBeNull();
  });

  it("strips heartbeat lines from the prompt and remaps evidence to original lines", async () => {
    const transcript = [
      ...heartbeatPairs(3),
      "User: the gateway is a2a.new.example now",
      "Assistant: noted",
    ].join("\n");
    const prompts: string[] = [];
    const result = await extractSessionFacts(transcript, "s", async (p) => {
      prompts.push(p);
      // The model cites filtered line 1 (the only user line it sees).
      return facts(1);
    });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).not.toContain("HEARTBEAT_OK");
    expect(prompts[0]).toContain("L1: User: the gateway is a2a.new.example now");
    expect(result?.heartbeatTurnsDropped).toBe(6);
    // Original transcript line 7 (after 6 heartbeat lines).
    expect(result?.facts[0]?.evidence).toEqual([{ kind: "session", path: "s", line: 7 }]);
  });

  it("windows a long transcript into several calls and merges facts + handover", async () => {
    const transcript = [
      "User: " + "alpha ".repeat(20),
      "Assistant: " + "beta ".repeat(20),
      "User: " + "gamma ".repeat(20),
      "Assistant: " + "delta ".repeat(20),
    ].join("\n");
    const prompts: string[] = [];
    const result = await extractSessionFacts(
      transcript,
      "s",
      async (p) => {
        prompts.push(p);
        return facts(1);
      },
      20,
      undefined,
      undefined,
      undefined,
      { maxTranscriptChars: 260 },
    );
    expect(prompts.length).toBe(2);
    expect(result?.windows).toBe(2);
    expect(result?.facts.map((f) => f.evidence[0])).toEqual([
      { kind: "session", path: "s", line: 1 },
      { kind: "session", path: "s", line: 3 },
    ]);
    // Milestones merged across windows (dedupe by text).
    expect(result?.handoverBrief.milestones).toEqual(["m1"]);
  });

  it("a truncated response still returns null (the manager parks it)", async () => {
    const result = await extractSessionFacts(
      "User: hi\nAssistant: hello",
      "s",
      async () => '{"facts": [{"text": "cut off',
    );
    expect(result).toBeNull();
  });
});
