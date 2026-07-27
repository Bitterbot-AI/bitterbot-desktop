import fsSync from "node:fs";
import type { BitterbotConfig } from "../config/config.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import { probeSqliteVec } from "../memory/sqlite-vec.js";
import { resolveUserPath } from "../utils.js";
import { renderSection, type CheckResult, ok, warn, info } from "./doctor-check.js";

const SECTION = "Memory search";

/**
 * Check whether memory search has a usable embedding provider and a working
 * sqlite-vec extension. Runs as part of `bitterbot doctor` — config + local
 * probe only, no network calls.
 *
 * On the shared check contract: a broken sqlite-vec load (the incident class
 * that silently degraded all semantic recall to keyword-only) used to be a
 * `note()` invisible to `--json` and the exit code; now it is a structured
 * warn finding. Healthy states report explicit `ok` results instead of the
 * old silent success, so a healthy section is distinguishable from one that
 * never ran.
 */
export async function runMemorySearchChecks(cfg: BitterbotConfig): Promise<void> {
  const results = await collectMemorySearchResults(cfg);
  renderSection(SECTION, results);
}

async function collectMemorySearchResults(cfg: BitterbotConfig): Promise<CheckResult[]> {
  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const resolved = resolveMemorySearchConfig(cfg, agentId);
  const hasRemoteApiKey = Boolean(resolved?.remote?.apiKey?.trim());

  if (!resolved) {
    return [info("Memory search is explicitly disabled (enabled: false).")];
  }

  const results: CheckResult[] = [];

  // Vector search needs the native sqlite-vec extension on top of a configured
  // embedding provider. A configured provider with a broken extension still
  // silently degrades to keyword-only, so surface that here independent of the
  // provider checks below.
  const probe = await probeSqliteVec();
  if (probe.ok) {
    results.push(ok("sqlite-vec extension loads — vector search available."));
  } else {
    results.push(
      warn(
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
      ),
    );
  }

  // If a specific provider is configured (not "auto"), check only that one.
  if (resolved.provider !== "auto") {
    if (resolved.provider === "local") {
      if (hasLocalEmbeddings(resolved.local)) {
        results.push(ok("Embedding provider: local model file present."));
      } else {
        results.push(
          warn(
            [
              'Memory search provider is set to "local" but no local model file was found.',
              "",
              "Fix (pick one):",
              `- Install node-llama-cpp and set a local model path in config`,
              `- Switch to a remote provider: ${formatCliCommand("bitterbot config set agents.defaults.memorySearch.provider openai")}`,
              "",
              `Verify: ${formatCliCommand("bitterbot memory status --deep")}`,
            ].join("\n"),
          ),
        );
      }
      return results;
    }
    // Remote provider — check for API key
    if (hasRemoteApiKey || (await hasApiKeyForProvider(resolved.provider, cfg, agentDir))) {
      results.push(ok(`Embedding provider: ${resolved.provider} (API key present).`));
      return results;
    }
    const envVar = providerEnvVar(resolved.provider);
    results.push(
      warn(
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
      ),
    );
    return results;
  }

  // provider === "auto": check all providers in resolution order
  if (hasLocalEmbeddings(resolved.local)) {
    results.push(ok("Embedding provider: local model file present (auto)."));
    return results;
  }
  for (const provider of ["openai", "gemini", "voyage"] as const) {
    if (hasRemoteApiKey || (await hasApiKeyForProvider(provider, cfg, agentDir))) {
      results.push(ok(`Embedding provider: ${provider} (auto, API key present).`));
      return results;
    }
  }

  results.push(
    warn(
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
    ),
  );
  return results;
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
