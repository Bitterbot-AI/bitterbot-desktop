import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "./tool-definition-adapter.js";

type AdapterTool = Parameters<typeof toToolDefinitions>[0][number];

/**
 * The pi engine validates arguments inside the library, whose message for a
 * wrong enum value does not say what the values are. The adapter's
 * prepareArguments hook runs first and is where the hint has to come from.
 */

const browserLike = (prepareArguments?: (args: unknown) => unknown) =>
  ({
    name: "browser",
    label: "Browser",
    description: "drive the browser",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "snapshot", "act"] },
        targetUrl: { type: "string" },
      },
    },
    ...(prepareArguments ? { prepareArguments } : {}),
    execute: async () => ({ content: [], details: {} }),
  }) as unknown as AdapterTool;

describe("pi tool definition adapter: enum hints", () => {
  it("rejects a wrong action before the library does, naming the allowed ones", () => {
    const [def] = toToolDefinitions([browserLike()]);

    expect(() => def.prepareArguments?.({ action: "read" })).toThrow(
      /Allowed values for "action": "open", "snapshot", "act"/,
    );
  });

  it("passes valid arguments through untouched", () => {
    const [def] = toToolDefinitions([browserLike()]);
    const args = { action: "open", targetUrl: "https://example.com" };

    expect(def.prepareArguments?.(args)).toBe(args);
  });

  it("still runs the tool's own argument shim, and checks its output", () => {
    // A shim that maps a legacy spelling onto the real one must be able to
    // rescue the call before the enum check sees it.
    const shim = (raw: unknown) => {
      const args = raw as { action?: string };
      return args.action === "navigate" ? { ...args, action: "open" } : args;
    };
    const [def] = toToolDefinitions([browserLike(shim)]);

    expect(def.prepareArguments?.({ action: "navigate" })).toEqual({ action: "open" });
    expect(() => def.prepareArguments?.({ action: "read" })).toThrow(/Allowed values/);
  });
});
