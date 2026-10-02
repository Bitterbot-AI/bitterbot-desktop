import { describe, expect, it } from "vitest";
import {
  enumHintsForArguments,
  rejectUnknownEnumStrings,
  withEnumHints,
} from "./validation-hints.js";

// The browser tool's shape: an `action` enum the model has to hit exactly.
const browserParameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["open", "snapshot", "screenshot", "act", "tabs"] },
    targetUrl: { type: "string" },
    // How TypeBox writes a union of literals.
    mode: { anyOf: [{ const: "efficient" }, { const: "full" }] },
    count: { enum: [1, 2, 3] },
  },
};

describe("enumHintsForArguments", () => {
  it("names the allowed values for the argument the model got wrong", () => {
    expect(enumHintsForArguments(browserParameters, { action: "read" })).toBe(
      'Allowed values for "action": "open", "snapshot", "screenshot", "act", "tabs".',
    );
  });

  it("reads a union of literals as an enum", () => {
    expect(enumHintsForArguments(browserParameters, { action: "open", mode: "fast" })).toBe(
      'Allowed values for "mode": "efficient", "full".',
    );
  });

  it("says nothing when every enum argument is valid or absent", () => {
    expect(enumHintsForArguments(browserParameters, { action: "snapshot" })).toBe("");
    expect(enumHintsForArguments(browserParameters, { targetUrl: "https://example.com" })).toBe("");
  });

  it("says nothing for schemas and arguments it cannot read", () => {
    expect(enumHintsForArguments(undefined, { action: "read" })).toBe("");
    expect(enumHintsForArguments(browserParameters, "read")).toBe("");
    expect(
      enumHintsForArguments({ properties: { a: { anyOf: [{ type: "string" }] } } }, { a: 1 }),
    ).toBe("");
  });

  it("stays short for a very large enum", () => {
    const big = { properties: { code: { enum: Array.from({ length: 500 }, (_, i) => `v${i}`) } } };

    const hint = enumHintsForArguments(big, { code: "nope" });

    expect(hint.length).toBeLessThanOrEqual(600);
    expect(hint).toContain('"v0"');
  });
});

describe("withEnumHints", () => {
  it("keeps the validator's message and adds what it left out", () => {
    const message =
      'Validation failed for tool "browser":\n  - action: must be equal to one of the allowed values';

    const out = withEnumHints(message, browserParameters, { action: "content" });

    expect(out.startsWith(message)).toBe(true);
    expect(out).toContain('Allowed values for "action": "open", "snapshot"');
  });

  it("returns the message unchanged when the failure is not about an enum", () => {
    const message = 'Validation failed for tool "browser":\n  - targetUrl: must be string';

    expect(withEnumHints(message, browserParameters, { action: "open", targetUrl: 5 })).toBe(
      message,
    );
  });
});

describe("rejectUnknownEnumStrings", () => {
  it("rejects a wrong action in one step, with the values and the arguments", () => {
    // The six guesses of 2026-10-02 (read, content, help, evaluate, extract,
    // text) each got "must be equal to one of the allowed values" and nothing more.
    expect(() =>
      rejectUnknownEnumStrings("browser", browserParameters, { action: "read" }),
    ).toThrow(
      /Validation failed for tool "browser":[\s\S]*action: "read" is not an allowed value[\s\S]*Allowed values for "action": "open", "snapshot"[\s\S]*Received arguments/,
    );
  });

  it("lets a valid call through", () => {
    expect(() =>
      rejectUnknownEnumStrings("browser", browserParameters, {
        action: "open",
        targetUrl: "https://x",
      }),
    ).not.toThrow();
  });

  it("leaves non-string values to the library, which coerces before it validates", () => {
    // "2" is accepted for a numeric enum after coercion; rejecting it here
    // would break calls that work today.
    expect(() =>
      rejectUnknownEnumStrings("t", browserParameters, { action: "open", count: "2" }),
    ).not.toThrow();
    expect(() => rejectUnknownEnumStrings("t", browserParameters, { action: 7 })).not.toThrow();
  });

  it("ignores missing arguments: required-ness is the validator's job", () => {
    expect(() => rejectUnknownEnumStrings("browser", browserParameters, {})).not.toThrow();
    expect(() => rejectUnknownEnumStrings("browser", browserParameters, undefined)).not.toThrow();
  });
});
