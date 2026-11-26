import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveModel } from "../embedded-runner/model.js";
import { resolveSubModel } from "./deep-recall-tool.js";

// Unmocked on purpose: every model deep recall can pick on "auto" has to load from the real
// catalog (or a forward-compat rule), or the recursive calls fail with "Unknown model".
it("auto sub-models all resolve to a usable model", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-sub-model-"));
  const envKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"] as const;
  const saved = envKeys.map((key) => [key, process.env[key]] as const);
  try {
    for (const only of envKeys) {
      for (const key of envKeys) {
        delete process.env[key];
      }
      process.env[only] = "test-key";
      const sub = await resolveSubModel(undefined, "auto");
      if (!sub) {
        // A stored credential for an earlier provider on this machine can win; skip then.
        continue;
      }
      const resolved = resolveModel(sub.provider, sub.model, agentDir, undefined);
      expect(resolved.error, `${sub.provider}/${sub.model}`).toBeUndefined();
      expect(resolved.model?.id).toBe(sub.model);
    }
    const google = resolveModel("google", "gemini-3.5-flash-lite", agentDir, undefined);
    expect(google.error).toBeUndefined();
    expect(google.model).toMatchObject({ provider: "google", api: "google-generative-ai" });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
