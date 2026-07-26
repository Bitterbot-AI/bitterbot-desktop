import { describe, expect, it } from "vitest";
import { classifyModelCheck } from "./doctor-model.js";

// The classifier IS the safety calibration: which model failures block the
// update gate (error) vs merely warn. A live call can't run in tests, so this
// pins the severity policy directly.

describe("classifyModelCheck", () => {
  it("ok on a successful round-trip", () => {
    expect(classifyModelCheck({ kind: "ok", latencyMs: 312, sample: "OK" })).toMatchObject({
      level: "ok",
    });
  });

  it("info when skipped", () => {
    expect(classifyModelCheck({ kind: "skipped", reason: "test environment" })).toMatchObject({
      level: "info",
    });
  });

  it("WARNs (does not block) on missing/invalid credentials", () => {
    for (const msg of [
      "no api key found for provider anthropic",
      "401 Unauthorized",
      "authentication_error: invalid x-api-key",
      "judge LLM call is not registered",
    ]) {
      expect(classifyModelCheck({ kind: "error", message: msg }), msg).toMatchObject({
        level: "warn",
      });
    }
  });

  it("WARNs (does not block) on transient/network/rate/5xx errors", () => {
    for (const msg of [
      "timeout",
      "ECONNRESET",
      "fetch failed",
      "429 rate_limit_error",
      "503 Service Unavailable",
    ]) {
      expect(classifyModelCheck({ kind: "error", message: msg }), msg).toMatchObject({
        level: "warn",
      });
    }
  });

  it("ERRORs (blocks the gate) on a well-formed request the provider rejected", () => {
    // The temperature-on-Opus class: a 400 param rejection, or a masked
    // provider error surfaced as empty content.
    for (const msg of [
      "400 temperature: unsupported parameter for this model",
      "provider error: model returned no text content",
      "422 unprocessable: bad request shape",
    ]) {
      expect(classifyModelCheck({ kind: "error", message: msg }), msg).toMatchObject({
        level: "error",
      });
    }
  });
});
