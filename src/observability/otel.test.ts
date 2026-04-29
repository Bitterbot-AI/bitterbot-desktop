import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initOtel, isOtelEnabled, withSpan } from "./otel.js";

const STATE_KEY = Symbol.for("bitterbot.observability.otel");

function resetState() {
  const proc = process as NodeJS.Process & { [k: symbol]: unknown };
  delete proc[STATE_KEY];
  delete process.env.OTEL_TRACES_EXPORTER;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
}

describe("observability/otel", () => {
  beforeEach(resetState);
  afterEach(resetState);

  it("isOtelEnabled returns false when no OTEL env vars set", () => {
    expect(isOtelEnabled()).toBe(false);
  });

  it("isOtelEnabled returns true when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    expect(isOtelEnabled()).toBe(true);
  });

  it("initOtel is a no-op when disabled", async () => {
    const result = await initOtel();
    expect(result).toBe(false);
  });

  it("initOtel is idempotent", async () => {
    const first = await initOtel();
    const second = await initOtel();
    expect(first).toBe(second);
  });

  it("withSpan runs the function unchanged when OTel is disabled", async () => {
    await initOtel();
    const result = await withSpan("test.span", async () => 42);
    expect(result).toBe(42);
  });

  it("withSpan propagates exceptions when disabled", async () => {
    await initOtel();
    await expect(
      withSpan("test.span", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
