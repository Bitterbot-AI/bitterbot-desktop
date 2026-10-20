import { describe, expect, it } from "vitest";
import { describeAuditEvent, describeOrigin, type MemorySummary } from "./MemoryView";

const m = (o: Partial<MemorySummary>): MemorySummary => ({
  id: "x",
  kind: "own",
  editable: true,
  source: "memory",
  semanticType: null,
  createdAt: null,
  updatedAt: null,
  path: null,
  preview: "",
  ...o,
});

describe("describeOrigin", () => {
  it("says where a memory came from", () => {
    expect(describeOrigin(m({ semanticType: "fact" }))).toBe("fact, remembered by your agent");
    expect(describeOrigin(m({ kind: "file", source: "sessions" }))).toBe("from a conversation");
    expect(describeOrigin(m({ kind: "file", source: "memory", path: "MEMORY.md" }))).toBe(
      "from MEMORY.md",
    );
  });
});

describe("describeAuditEvent", () => {
  it("puts owner-facing events in words and hides internal bookkeeping", () => {
    expect(describeAuditEvent({ event: "owner_forget" })).toBe("You deleted a memory");
    expect(describeAuditEvent({ event: "forgotten" })).toMatch(/Faded out/);
    expect(describeAuditEvent({ event: "plan21_slow_update_fired" })).toBeNull();
  });
});
