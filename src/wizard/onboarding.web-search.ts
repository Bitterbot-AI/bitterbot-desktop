/**
 * Onboarding wizard step: web search provider + API key.
 *
 * The agent's `web_search` tool is one of its most-used capabilities —
 * it's how it answers factual questions, researches skills during dreams,
 * and feeds the curiosity engine. Without a key the tool silently fails,
 * which confuses new operators ("why doesn't it know anything recent?").
 *
 * This step:
 *   1. Checks if a key is already present (config or env var)
 *   2. If not, asks the user to pick a provider and paste a key
 *   3. On quickstart, auto-detects from env vars and skips if found
 *
 * Supported providers: Brave Search, Perplexity, Grok (xAI), Tavily.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

type SearchProvider = "brave" | "perplexity" | "grok" | "tavily";

const PROVIDERS: Record<
  SearchProvider,
  { label: string; hint: string; envVar: string; keyPlaceholder: string }
> = {
  brave: {
    label: "Brave Search",
    hint: "Free tier available — https://brave.com/search/api/",
    envVar: "BRAVE_API_KEY",
    keyPlaceholder: "BSA...",
  },
  tavily: {
    label: "Tavily",
    hint: "Built for AI agents — https://tavily.com",
    envVar: "TAVILY_API_KEY",
    keyPlaceholder: "tvly-...",
  },
  perplexity: {
    label: "Perplexity",
    hint: "Sonar API — https://docs.perplexity.ai",
    envVar: "PERPLEXITY_API_KEY",
    keyPlaceholder: "pplx-...",
  },
  grok: {
    label: "Grok (xAI)",
    hint: "Uses xAI API — https://x.ai",
    envVar: "XAI_API_KEY",
    keyPlaceholder: "xai-...",
  },
};

function detectExistingKey(config: BitterbotConfig): {
  provider: SearchProvider;
  source: "config" | "env";
} | null {
  const search = config.tools?.web?.search;
  const provider = (search?.provider ?? "brave") as SearchProvider;

  // Check config first
  if (provider === "brave" && search?.apiKey) {
    return { provider, source: "config" };
  }
  const providerBlock = (search as Record<string, Record<string, unknown>> | undefined)?.[provider];
  if (providerBlock?.apiKey) {
    return { provider, source: "config" };
  }

  // Check env vars
  for (const [p, meta] of Object.entries(PROVIDERS)) {
    if (process.env[meta.envVar]?.trim()) {
      return { provider: p as SearchProvider, source: "env" };
    }
  }

  return null;
}

export async function setupWebSearchForOnboarding(params: {
  config: BitterbotConfig;
  flow: WizardFlow;
  prompter: WizardPrompter;
}): Promise<BitterbotConfig> {
  const { config, flow, prompter } = params;

  // ── Check for existing key ──
  const existing = detectExistingKey(config);

  if (existing) {
    const meta = PROVIDERS[existing.provider];
    await prompter.note(
      [
        `Web search is already configured (${meta.label} via ${existing.source === "env" ? `${meta.envVar} env var` : "stored API key"}).`,
        "Your agent can look things up online during conversations and dream cycles.",
      ].join("\n"),
      "Web search",
    );
    return config;
  }

  // ── Intro ──
  await prompter.note(
    [
      "Web search powers your agent's ability to look things up — current",
      "events, documentation, research during dream cycles, and the",
      "curiosity engine's exploration targets. Without a key, the",
      "`web_search` tool silently fails and the agent can't learn from the web.",
      "",
      "Supported: Brave Search (free tier), Tavily (built for AI agents),",
      "Perplexity (Sonar API), Grok (xAI). Pick one and paste your API key.",
      "",
      "You can also set the key as an env var and skip this step:",
      "  BRAVE_API_KEY, TAVILY_API_KEY, PERPLEXITY_API_KEY, or XAI_API_KEY",
    ].join("\n"),
    "Web search",
  );

  // ── Ask whether to configure now ──
  const wantSearch =
    flow === "quickstart"
      ? true
      : await prompter.confirm({
          message:
            "Set up a web search provider now? (highly recommended — the agent is much less useful without it)",
          initialValue: true,
        });

  if (!wantSearch) {
    await prompter.note(
      [
        "Skipped. Set one up later via:",
        "  bitterbot configure --section web",
        "Or just export one of the env vars (BRAVE_API_KEY, TAVILY_API_KEY, etc.).",
      ].join("\n"),
      "Web search skipped",
    );
    return config;
  }

  // ── Pick provider ──
  const provider = (await prompter.select({
    message: "Which search provider?",
    options: Object.entries(PROVIDERS).map(([value, meta]) => ({
      value,
      label: meta.label,
      hint: meta.hint,
    })),
    initialValue: "tavily",
  })) as SearchProvider;

  const meta = PROVIDERS[provider];

  // ── Paste key ──
  const keyInput = await prompter.text({
    message: `${meta.label} API key (or leave blank to use ${meta.envVar} env var later)`,
    placeholder: meta.keyPlaceholder,
  });

  const key = String(keyInput ?? "").trim();

  if (!key) {
    await prompter.note(
      [
        `No key entered. Set ${meta.envVar} in the gateway environment before starting.`,
        `The \`web_search\` tool won't work until a key is available.`,
      ].join("\n"),
      "Web search",
    );
    return {
      ...config,
      tools: {
        ...config.tools,
        web: {
          ...config.tools?.web,
          search: {
            ...config.tools?.web?.search,
            provider,
            enabled: true,
          },
        },
      },
    };
  }

  // ── Store key in config ──
  const searchBase = {
    ...config.tools?.web?.search,
    provider,
    enabled: true,
  };

  const nextSearch =
    provider === "brave"
      ? { ...searchBase, apiKey: key }
      : {
          ...searchBase,
          [provider]: {
            ...((searchBase as Record<string, unknown>)[provider] as
              | Record<string, unknown>
              | undefined),
            apiKey: key,
          },
        };

  await prompter.note(
    `${meta.label} configured. Your agent can now search the web.`,
    "Web search ready",
  );

  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search: nextSearch,
      },
    },
  };
}
