import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import {
  ATLASCLOUD_BASE_URL,
  buildAtlasCloudProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

const ATLAS_ENV_VARS = ["ATLASCLOUD_API_KEY", "ATLAS_CLOUD_API_KEY"];

describe("Atlas Cloud provider", () => {
  it.each(ATLAS_ENV_VARS)("includes atlascloud when %s is configured", async (envVar) => {
    const agentDir = mkdtempSync(join(tmpdir(), "bitterbot-test-"));
    const envSnapshot = captureEnv(ATLAS_ENV_VARS);
    delete process.env.ATLASCLOUD_API_KEY;
    delete process.env.ATLAS_CLOUD_API_KEY;
    process.env[envVar] = "atlascloud-test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.atlascloud).toMatchObject({
        apiKey: envVar,
        baseUrl: ATLASCLOUD_BASE_URL,
        api: "openai-completions",
      });
    } finally {
      envSnapshot.restore();
    }
  });

  it("does not include atlascloud without a key", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "bitterbot-test-"));
    const envSnapshot = captureEnv(ATLAS_ENV_VARS);
    delete process.env.ATLASCLOUD_API_KEY;
    delete process.env.ATLAS_CLOUD_API_KEY;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.atlascloud).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("resolves the preferred Atlas Cloud environment variable", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "bitterbot-test-"));
    const envSnapshot = captureEnv(ATLAS_ENV_VARS);
    process.env.ATLASCLOUD_API_KEY = "preferred-key";
    process.env.ATLAS_CLOUD_API_KEY = "fallback-key";

    try {
      const auth = await resolveApiKeyForProvider({ provider: "atlascloud", agentDir });
      expect(auth.apiKey).toBe("preferred-key");
      expect(auth.source).toContain("ATLASCLOUD_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("builds the OpenAI-compatible Atlas Cloud model catalog", () => {
    const provider = buildAtlasCloudProvider();
    expect(provider.baseUrl).toBe("https://api.atlascloud.ai/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.map((model) => model.id)).toEqual([
      "deepseek-ai/deepseek-v4-pro",
      "deepseek-ai/deepseek-v4-flash",
      "qwen/qwen3.5-27b",
    ]);
  });
});
