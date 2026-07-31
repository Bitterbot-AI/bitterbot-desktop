import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { probeProviderKey, resolveProbeRecipe } from "./auth-probe.js";

vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithTimeout);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("resolveProbeRecipe", () => {
  it("uses the built-in recipe for known providers", () => {
    expect(resolveProbeRecipe({ provider: "anthropic" })).toEqual({
      baseUrl: "https://api.anthropic.com/v1",
      style: "anthropic",
    });
  });

  it("prefers an explicit baseUrl and infers style from configured api", () => {
    const cfg = {
      models: {
        providers: {
          "my-proxy": { baseUrl: "https://proxy.example/v1", api: "anthropic-messages" },
        },
      },
    } as never;
    expect(resolveProbeRecipe({ provider: "my-proxy", cfg })).toEqual({
      baseUrl: "https://proxy.example/v1",
      style: "anthropic",
    });
  });

  it("returns null for unknown providers with no baseUrl", () => {
    expect(resolveProbeRecipe({ provider: "mystery" })).toBeNull();
  });
});

describe("probeProviderKey", () => {
  it("probes anthropic with x-api-key and reports success", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    const result = await probeProviderKey({ provider: "anthropic", apiKey: "sk-ant-x" });
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect((init as { headers: Record<string, string> }).headers["x-api-key"]).toBe("sk-ant-x");
  });

  it("probes openai-style providers with a Bearer header", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
    await probeProviderKey({ provider: "groq", apiKey: "gsk-x" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/models");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer gsk-x",
    );
  });

  it("maps 401 to a refusal with a human-readable error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 } as never);
    const result = await probeProviderKey({ provider: "openai", apiKey: "bad" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("unauthorized");
  });

  it("treats 429 as authenticated-but-rate-limited success", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 } as never);
    const result = await probeProviderKey({ provider: "openai", apiKey: "busy" });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(429);
  });

  it("flags providers without a probe recipe as unsupported", async () => {
    const result = await probeProviderKey({ provider: "mystery", apiKey: "k" });
    expect(result.ok).toBe(false);
    expect(result.unsupported).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never includes the key in the failure detail", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const result = await probeProviderKey({ provider: "openai", apiKey: "sk-secret-123" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-secret-123");
  });
});
