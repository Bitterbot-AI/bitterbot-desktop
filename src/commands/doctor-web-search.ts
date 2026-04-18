/**
 * Top-level Web Search doctor section.
 *
 * Web search is the agent's primary "look something up" capability — it
 * feeds the curiosity engine, powers dream-cycle research, and backs the
 * `web_search` tool in normal conversations. Without a key, the tool
 * silently no-ops and the agent can't learn from the web.
 *
 * What we check (config-only, no network):
 *   1. `tools.web.search` block is present and not disabled
 *   2. A provider is selected (brave / perplexity / grok / tavily)
 *   3. A key is reachable for that provider — either in config or via
 *      the provider's well-known env var
 *
 * What we deliberately don't check:
 *   - Live provider reachability (noisy in flaky networks; runtime surfaces
 *     real failures with actionable errors)
 *   - Quota / rate-limit headers (we don't speak the wire to ask)
 */

import type { BitterbotConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { note } from "../terminal/note.js";

type SearchProvider = "brave" | "perplexity" | "grok" | "tavily";

type Level = "ok" | "warn" | "error" | "info";
type CheckResult = { level: Level; message: string };

const ok = (message: string): CheckResult => ({ level: "ok", message });
const warn = (message: string): CheckResult => ({ level: "warn", message });
const info = (message: string): CheckResult => ({ level: "info", message });

function formatLevel(r: CheckResult): string {
  switch (r.level) {
    case "ok":
      return `\u2714 ${r.message}`;
    case "warn":
      return `\u26A0 ${r.message}`;
    case "error":
      return `\u2718 ${r.message}`;
    case "info":
      return `\u2139 ${r.message}`;
  }
}

const PROVIDER_ENV_VARS: Record<SearchProvider, readonly string[]> = {
  brave: ["BRAVE_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  grok: ["XAI_API_KEY", "GROK_API_KEY"],
  tavily: ["TAVILY_API_KEY"],
};

function envHasKey(provider: SearchProvider): string | null {
  for (const envVar of PROVIDER_ENV_VARS[provider]) {
    if (process.env[envVar]?.trim()) {
      return envVar;
    }
  }
  return null;
}

function configKeyForProvider(
  cfg: BitterbotConfig,
  provider: SearchProvider,
): { found: boolean; location: string } {
  const search = cfg.tools?.web?.search;
  if (!search) {
    return { found: false, location: "" };
  }
  if (provider === "brave" && search.apiKey?.trim()) {
    return { found: true, location: "tools.web.search.apiKey" };
  }
  const block = (search as Record<string, unknown>)[provider] as { apiKey?: string } | undefined;
  if (block?.apiKey?.trim()) {
    return { found: true, location: `tools.web.search.${provider}.apiKey` };
  }
  return { found: false, location: "" };
}

export function runWebSearchChecks(params: { config: BitterbotConfig }): void {
  const { config } = params;
  const search = config.tools?.web?.search;
  const results: CheckResult[] = [];

  if (search?.enabled === false) {
    results.push(
      info(
        "Web search disabled (tools.web.search.enabled = false). Agent can't look " +
          "things up online — curiosity engine and dream-cycle research will be limited.",
      ),
    );
    renderSection(results);
    return;
  }

  const provider = (search?.provider ?? null) as SearchProvider | null;

  if (!provider) {
    results.push(
      warn(
        [
          "No web search provider configured.",
          "  Fix: " +
            formatCliCommand("bitterbot config set tools.web.search.provider brave") +
            " (or perplexity / grok / tavily)",
          "  Then either paste a key via `bitterbot configure` or export the",
          "  provider's env var (BRAVE_API_KEY / PERPLEXITY_API_KEY / XAI_API_KEY / TAVILY_API_KEY).",
        ].join("\n"),
      ),
    );
    renderSection(results);
    return;
  }

  results.push(ok(`Provider: ${provider}`));

  const configKey = configKeyForProvider(config, provider);
  const envVar = envHasKey(provider);
  if (configKey.found) {
    results.push(ok(`API key present (${configKey.location})`));
  } else if (envVar) {
    results.push(ok(`API key present (${envVar} env var)`));
  } else {
    const envList = PROVIDER_ENV_VARS[provider].join(" or ");
    results.push(
      warn(
        [
          `No ${provider} API key found — web_search tool will fail at runtime.`,
          `  Fix (pick one):`,
          `    - Export ${envList} in the gateway environment`,
          `    - Paste one via ${formatCliCommand("bitterbot configure")}`,
          `    - Switch provider: ${formatCliCommand("bitterbot config set tools.web.search.provider tavily")}`,
        ].join("\n"),
      ),
    );
  }

  renderSection(results);
}

function renderSection(results: CheckResult[]): void {
  if (results.length === 0) {
    return;
  }
  note(results.map(formatLevel).join("\n"), "Web search");
}
