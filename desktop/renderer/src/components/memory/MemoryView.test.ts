import { describe, expect, it } from "vitest";
import { describeOrigin, type MemorySummary } from "./MemoryView";

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
