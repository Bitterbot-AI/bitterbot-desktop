import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("config: tools.hotSet + tools.resultMaxChars", () => {
  it("accepts the documented block globally and per agent", () => {
    const res = validateConfigObject({
      tools: {
        hotSet: {
          enabled: true,
          max: 10,
          always: ["read", "memory_search"],
          perLane: { chat: ["exec", "message"], heartbeat: ["message"] },
        },
        resultMaxChars: 12000,
      },
      agents: {
        list: [{ id: "main", tools: { hotSet: { perLane: { cron: ["exec"] } } } }],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown lanes, unknown keys, and a cap under 1000 chars", () => {
    expect(validateConfigObject({ tools: { hotSet: { perLane: { nightly: ["exec"] } } } }).ok).toBe(
      false,
    );
    expect(validateConfigObject({ tools: { hotSet: { hot: ["exec"] } } }).ok).toBe(false);
    expect(validateConfigObject({ tools: { resultMaxChars: 10 } }).ok).toBe(false);
    expect(validateConfigObject({ tools: { hotSet: { max: 0 } } }).ok).toBe(false);
  });
});
