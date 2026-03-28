import { afterEach, describe, expect, it } from "vitest";
import { createExpandMessageTool } from "./expand-message-tool.js";
import {
  truncateWithReference,
  clearTruncatedOriginals,
  getOriginalContent,
} from "../progressive-compression.js";

afterEach(() => {
  clearTruncatedOriginals();
});

describe("expand_message tool", () => {
  const tool = createExpandMessageTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("expand_message");
    expect(tool.parameters).toBeDefined();
  });

  it("retrieves original content by reference", async () => {
    const original = "This is the original content. ".repeat(100);
    const truncated = truncateWithReference(original, 50);
    const match = truncated.match(/Reference: ([a-f0-9]+)/);
    expect(match).not.toBeNull();
    const fingerprint = match![1];

    const result = await tool.execute("call_1", { reference: fingerprint });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe(original);
    expect((result.details as { ok: boolean }).ok).toBe(true);
  });

  it("returns error for missing reference", async () => {
    const result = await tool.execute("call_2", { reference: "nonexistent" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not available");
    expect((result.details as { ok: boolean }).ok).toBe(false);
  });

  it("returns error when reference is empty", async () => {
    const result = await tool.execute("call_3", { reference: "" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("required");
    expect((result.details as { ok: boolean }).ok).toBe(false);
  });

  it("returns error when reference param is missing", async () => {
    const result = await tool.execute("call_4", {});
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("required");
  });

  it("works end-to-end: truncate → get fingerprint → expand", async () => {
    const content = "Critical data: " + "A".repeat(5000);
    const truncated = truncateWithReference(content, 100);

    // Verify the content was stored
    const match = truncated.match(/Reference: ([a-f0-9]+)/);
    expect(match).not.toBeNull();
    expect(getOriginalContent(match![1])).toBe(content);

    // Use the tool to expand
    const result = await tool.execute("call_5", { reference: match![1] });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe(content);
  });

  it("survives clear (simulating session end)", async () => {
    const content = "session data " + "B".repeat(5000);
    const truncated = truncateWithReference(content, 100);
    const match = truncated.match(/Reference: ([a-f0-9]+)/)!;

    // Clear simulates session end
    clearTruncatedOriginals();

    const result = await tool.execute("call_6", { reference: match[1] });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not available");
  });
});
