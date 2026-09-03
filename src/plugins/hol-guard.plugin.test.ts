import { describe, expect, it, vi } from "vitest";
import { createHolGuardBeforeToolCallHandler } from "../../extensions/hol-guard/index.js";

describe("HOL Guard plugin", () => {
  it("allows exec only when HOL Guard explicitly allows the command", async () => {
    const inspect = vi.fn().mockResolvedValue(true);
    const handler = createHolGuardBeforeToolCallHandler(inspect);

    await expect(handler({ toolName: "exec", params: { command: "git status" } })).resolves.toBeUndefined();
    expect(inspect).toHaveBeenCalledWith("git status");
  });

  it("blocks exec when HOL Guard does not explicitly allow the command", async () => {
    const handler = createHolGuardBeforeToolCallHandler(vi.fn().mockResolvedValue(false));

    await expect(handler({ toolName: "exec", params: { command: "rm -rf ./tmp" } })).resolves.toEqual({
      block: true,
      blockReason: "HOL Guard: command requires review before execution.",
    });
  });

  it("fails closed when HOL Guard inspection errors", async () => {
    const handler = createHolGuardBeforeToolCallHandler(
      vi.fn().mockRejectedValue(new Error("guard unavailable")),
    );

    await expect(handler({ toolName: "exec", params: { command: "npm publish" } })).resolves.toEqual({
      block: true,
      blockReason: "HOL Guard: command inspection failed.",
    });
  });

  it("blocks malformed exec input and ignores unrelated tools", async () => {
    const inspect = vi.fn().mockResolvedValue(true);
    const handler = createHolGuardBeforeToolCallHandler(inspect);

    await expect(handler({ toolName: "exec", params: {} })).resolves.toEqual({
      block: true,
      blockReason: "HOL Guard: exec command text is missing or invalid.",
    });
    await expect(handler({ toolName: "read", params: { path: "README.md" } })).resolves.toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });
});
