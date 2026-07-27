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
      "overloaded_error: the model is overloaded",
      "internal server error",
    ]) {
      expect(classifyModelCheck({ kind: "error", message: msg }), msg).toMatchObject({
        level: "warn",
      });
    }
  });

  it("WARNs (does not block) when the configured model does not resolve", () => {
    for (const msg of [
      "judge-provider: cannot resolve model anthropic/claude-nonexistent",
      "unknown model ref",
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

  it("ERRORs even when the message embeds 5xx-looking digits that are not a status (regression)", () => {
    // A naive 500-599 substring scan matched dates inside model ids
    // ("...-20251101" contains "511"), token counts, and request-id UUIDs,
    // downgrading the exact 400-param class this check exists to catch into a
    // non-blocking warn.
    for (const msg of [
      "400 temperature: unsupported parameter for model claude-opus-4-5-20251101",
      "400 invalid_request_error: temperature unsupported for claude-sonnet-4-5-20250514",
      "provider error: model returned no text content (model=claude-opus-4-5-20251101)",
      "400 invalid_request_error: max_tokens: 512 exceeds the maximum",
      "400 invalid_request_error (request id 550e8400-e29b-41d4)",
    ]) {
      expect(classifyModelCheck({ kind: "error", message: msg }), msg).toMatchObject({
        level: "error",
      });
    }
  });

  it("still WARNs on a real 5xx status next to non-status digits", () => {
    for (const msg of [
      "502 Bad Gateway from provider (model claude-opus-4-5-20251101)",
      "Request failed with status code 529",
      "HTTP/2 503 from upstream",
    ]) {
      expect(classifyModelCheck({ kind: "error", message: msg }), msg).toMatchObject({
        level: "warn",
      });
    }
  });
});
