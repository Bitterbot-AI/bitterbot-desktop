import fsSync from "node:fs";
import type { BitterbotConfig } from "../config/config.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import { probeSqliteVec } from "../memory/sqlite-vec.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";

/**
 * Check whether memory search has a usable embedding provider.
 * Runs as part of `bitterbot doctor` — config-only, no network calls.
 */
export async function noteMemorySearchHealth(cfg: BitterbotConfig): Promise<void> {
  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const resolved = resolveMemorySearchConfig(cfg, agentId);
  const hasRemoteApiKey = Boolean(resolved?.remote?.apiKey?.trim());

  if (!resolved) {
    note("Memory search is explicitly disabled (enabled: false).", "Memory search");
    return;
  }

  // Vector search needs the native sqlite-vec extension on top of a configured
  // embedding provider. A configured provider with a broken extension still
  // silently degrades to keyword-only, so surface that here independent of the
  // provider checks below.
  await noteVectorSearchHealth();

  // If a specific provider is configured (not "auto"), check only that one.
  if (resolved.provider !== "auto") {
    if (resolved.provider === "local") {
      if (hasLocalEmbeddings(resolved.local)) {
        return; // local model file exists
      }
      note(
        [
          'Memory search provider is set to "local" but no local model file was found.',
          "",
          "Fix (pick one):",
          `- Install node-llama-cpp and set a local model path in config`,
          `- Switch to a remote provider: ${formatCliCommand("bitterbot config set agents.defaults.memorySearch.provider openai")}`,
          "",
          `Verify: ${formatCliCommand("bitterbot memory status --deep")}`,
        ].join("\n"),
        "Memory search",
      );
      return;
    }
    // Remote provider — check for API key
    if (hasRemoteApiKey || (await hasApiKeyForProvider(resolved.provider, cfg, agentDir))) {
      return;
    }
    const envVar = providerEnvVar(resolved.provider);
    note(
      [
        `Memory search provider is set to "${resolved.provider}" but no API key was found.`,
        `Semantic recall will not work without a valid API key.`,
        "",
        "Fix (pick one):",
        `- Set ${envVar} in your environment`,
        `- Add credentials: ${formatCliCommand(`bitterbot auth add --provider ${resolved.provider}`)}`,
        `- To disable: ${formatCliCommand("bitterbot config set agents.defaults.memorySearch.enabled false")}`,
        "",
        `Verify: ${formatCliCommand("bitterbot memory status --deep")}`,
      ].join("\n"),
      "Memory search",
    );
    return;
  }

  // provider === "auto": check all providers in resolution order
  if (hasLocalEmbeddings(resolved.local)) {
    return;
  }
  for (const provider of ["openai", "gemini", "voyage"] as const) {
    if (hasRemoteApiKey || (await hasApiKeyForProvider(provider, cfg, agentDir))) {
      return;
    }
  }

  note(
    [
      "Memory search is enabled but no embedding provider is configured.",
      "Semantic recall will not work without an embedding provider.",
      "",
      "Fix (pick one):",
      "- Set OPENAI_API_KEY or GEMINI_API_KEY in your environment",
      `- Add credentials: ${formatCliCommand("bitterbot auth add --provider openai")}`,
      `- For local embeddings: configure agents.defaults.memorySearch.provider and local model path`,
      `- To disable: ${formatCliCommand("bitterbot config set agents.defaults.memorySearch.enabled false")}`,
      "",
      `Verify: ${formatCliCommand("bitterbot memory status --deep")}`,
    ].join("\n"),
    "Memory search",
  );
}

async function noteVectorSearchHealth(): Promise<void> {
  const probe = await probeSqliteVec();
  if (probe.ok) {
    return; // vector search works; doctor only surfaces problems
  }
  note(
    [
      "Vector search is unavailable: the sqlite-vec extension did not load.",
      "Memory search will fall back to keyword-only (FTS) — semantic recall is degraded.",
      `Reason: ${probe.error ?? "unknown"}`,
      "",
      "This is a packaging/platform issue, not a config one. sqlite-vec ships as a",
      "dependency; reinstalling usually resolves it. Unsupported platforms have no",
      "prebuilt binary and will always fall back to keyword search.",
      "",
      `Verify: ${formatCliCommand("bitterbot memory status --deep")}`,
    ].join("\n"),
    "Memory search",
  );
}

function hasLocalEmbeddings(local: { modelPath?: string }): boolean {
  const modelPath = local.modelPath?.trim();
  if (!modelPath) {
    return false;
  }
  // Remote/downloadable models (hf: or http:) aren't pre-resolved on disk,
  // so we can't confirm availability without a network call. Treat as
  // potentially available — the user configured it intentionally.
  if (/^(hf:|https?:)/i.test(modelPath)) {
    return true;
  }
  const resolved = resolveUserPath(modelPath);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

async function hasApiKeyForProvider(
  provider: "openai" | "gemini" | "voyage",
  cfg: BitterbotConfig,
  agentDir: string,
): Promise<boolean> {
  // Map embedding provider names to model-auth provider names
  const authProvider = provider === "gemini" ? "google" : provider;
  try {
    await resolveApiKeyForProvider({ provider: authProvider, cfg, agentDir });
    return true;
  } catch {
    return false;
  }
}

function providerEnvVar(provider: string): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "voyage":
      return "VOYAGE_API_KEY";
    default:
      return `${provider.toUpperCase()}_API_KEY`;
  }
}
