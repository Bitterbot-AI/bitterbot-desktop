import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { PRUNE_RECORD_CUSTOM_TYPE } from "../compaction/types.js";
import {
  applyHeartbeatStubs,
  buildPruneRecordData,
  collectHeartbeatStubs,
  collectStubRecords,
  type HeartbeatStub,
} from "./offload-stubs.js";

const user = (text: string, timestamp: number) =>
  ({ role: "user", content: [{ type: "text", text }], timestamp }) as unknown as AgentMessage;
const assistant = (text: string, timestamp: number) =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp }) as unknown as AgentMessage;
const toolResult = (timestamp: number) =>
  ({ role: "toolResult", toolCallId: "t1", content: [], timestamp }) as unknown as AgentMessage;
const texts = (messages: AgentMessage[]) =>
  messages.map((m) => (m as { content: Array<{ text?: string }> }).content[0]?.text ?? m.role);

const HB = "heartbeat prompt";
const OK = "HEARTBEAT_OK";
const pair = (userTs: number, assistantTs: number): HeartbeatStub[] => [
  { entryId: `u${userTs}`, role: "user", timestamp: userTs, chars: HB.length },
  { entryId: `a${assistantTs}`, role: "assistant", timestamp: assistantTs, chars: OK.length },
];

describe("heartbeat-pair stubs", () => {
  it("round-trip through the prune record next to tool-output stubs", () => {
    const data = buildPruneRecordData(
      [{ toolCallId: "call-1", chars: 9000, toolName: "read" }],
      "turn-end",
      pair(10, 11),
    );
    const branch = [{ type: "custom", customType: PRUNE_RECORD_CUSTOM_TYPE, data }];
    expect(collectHeartbeatStubs(branch)).toEqual(pair(10, 11));
    // The tool-output reader skips them, and the reverse.
    expect([...collectStubRecords(branch).keys()]).toEqual(["call-1"]);
    expect(collectHeartbeatStubs([{ type: "custom", customType: "other", data }])).toEqual([]);
  });

  it("drop a recorded prompt and its acknowledgement, keeping the rest in order", () => {
    const messages = [
      user("real question", 1),
      assistant("real answer", 2),
      user(HB, 10),
      assistant(OK, 11),
      user("another question", 20),
      assistant("another answer", 21),
    ];
    const result = applyHeartbeatStubs(messages, pair(10, 11));
    expect(result.removed).toBe(2);
    expect(texts(result.messages)).toEqual([
      "real question",
      "real answer",
      "another question",
      "another answer",
    ]);
    // Idempotent.
    expect(applyHeartbeatStubs(result.messages, pair(10, 11)).removed).toBe(0);
  });

  it("drop a pair at the end of the window", () => {
    const messages = [user("q", 1), assistant("a", 2), user(HB, 10), assistant(OK, 11)];
    expect(texts(applyHeartbeatStubs(messages, pair(10, 11)).messages)).toEqual(["q", "a"]);
  });

  it("leave a turn alone unless the whole of it was recorded", () => {
    // The acknowledgement is missing from the record.
    const promptOnly = [{ entryId: "u10", role: "user" as const, timestamp: 10, chars: HB.length }];
    const messages = [user(HB, 10), assistant(OK, 11), user("q", 20)];
    expect(applyHeartbeatStubs(messages, promptOnly).removed).toBe(0);
    // The heartbeat turn ran a tool after the recorded acknowledgement.
    const withTool = [user(HB, 10), assistant(OK, 11), toolResult(12), assistant("done", 13)];
    expect(applyHeartbeatStubs(withTool, pair(10, 11)).removed).toBe(0);
    // Same timestamp, other role.
    const swapped = [assistant(HB, 10), user(OK, 11)];
    expect(applyHeartbeatStubs(swapped, pair(10, 11)).removed).toBe(0);
    // Same role and millisecond, other text: a real turn, not the heartbeat.
    const sameMs = [user("a real question", 10), assistant("a real answer", 11), user("q", 20)];
    expect(applyHeartbeatStubs(sameMs, pair(10, 11)).removed).toBe(0);
  });

  it("drop several acknowledgements of one heartbeat turn", () => {
    const stubs: HeartbeatStub[] = [
      ...pair(10, 11),
      { entryId: "a12", role: "assistant", timestamp: 12, chars: OK.length },
    ];
    const messages = [user(HB, 10), assistant(OK, 11), assistant(OK, 12), user("q", 20)];
    expect(texts(applyHeartbeatStubs(messages, stubs).messages)).toEqual(["q"]);
  });
});
