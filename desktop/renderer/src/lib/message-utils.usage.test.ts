import { describe, expect, it } from "vitest";
import { extractUsage } from "./message-utils";

describe("extractUsage", () => {
  it("reads the gateway's camelCase pi-ai usage and folds cache into the prompt", () => {
    expect(
      extractUsage({ usage: { input: 2, cacheRead: 48_000, cacheWrite: 1_000, output: 13 } }),
    ).toEqual({
      input: 49_002,
      output: 13,
      total: 49_015,
    });
  });
  it("still accepts snake_case provider payloads and rejects empty usage", () => {
    expect(extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } })).toEqual({
      input: 10,
      output: 5,
      total: 15,
    });
    expect(extractUsage({ usage: { input: 0, output: 0 } })).toBeUndefined();
    expect(extractUsage({})).toBeUndefined();
  });
});
