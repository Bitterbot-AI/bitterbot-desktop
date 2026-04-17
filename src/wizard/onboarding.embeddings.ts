/**
 * Onboarding wizard step: memory embeddings provider + API key.
 *
 * The agent's long-term memory search runs over vector embeddings. Without
 * a working embedding provider, MEMORY.md content doesn't become searchable,
 * session extraction can't dedup, and dream cycles can't cluster. The agent
 * still functions — it just forgets everything a conversation later.
 *
 * This step:
 *   1. Checks if an embedding key is already present (config or env var)
 *   2. If not, asks whether to configure now (recommended)
 *   3. Lets the user pick OpenAI / Gemini / Voyage and paste a key
 *
 * Local embeddings (node-llama-cpp) are not set up here — they need a model
 * download and a system-dependent toolchain, so we leave that to `bitterbot
 * configure` / docs.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

type EmbeddingProvider = "openai" | "gemini" | "voyage";

const PROVIDERS: Record<
  EmbeddingProvider,
  { label: string; hint: string; envVars: readonly string[]; keyPlaceholder: string }
> = {
  openai: {
    label: "OpenAI",
    hint: "text-embedding-3-small by default — https://platform.openai.com/api-keys",
    envVars: ["OPENAI_API_KEY"],
    keyPlaceholder: "sk-...",
  },
  gemini: {
    label: "Gemini (Google)",
    hint: "text-embedding-004 — https://aistudio.google.com/apikey",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyPlaceholder: "AIza...",
  },
  voyage: {
    label: "Voyage AI",
    hint: "voyage-3 — https://www.voyageai.com",
    envVars: ["VOYAGE_API_KEY"],
    keyPlaceholder: "pa-...",
  },
};

function detectExistingKey(config: BitterbotConfig): {
  provider: EmbeddingProvider;
  source: "config" | "env";
  envVar?: string;
} | null {
  const memorySearch = config.agents?.defaults?.memorySearch;
  const provider = memorySearch?.provider;
  const remoteKey = memorySearch?.remote?.apiKey?.trim();

  if (remoteKey && (provider === "openai" || provider === "gemini" || provider === "voyage")) {
    return { provider, source: "config" };
  }

  for (const [p, meta] of Object.entries(PROVIDERS)) {
    for (const envVar of meta.envVars) {
      if (process.env[envVar]?.trim()) {
        return { provider: p as EmbeddingProvider, source: "env", envVar };
      }
    }
  }

  return null;
}

export async function setupEmbeddingsForOnboarding(params: {
  config: BitterbotConfig;
  flow: WizardFlow;
  prompter: WizardPrompter;
}): Promise<BitterbotConfig> {
  const { config, flow, prompter } = params;

  const existing = detectExistingKey(config);

  if (existing) {
    const meta = PROVIDERS[existing.provider];
    await prompter.note(
      [
        `Memory embeddings already configured (${meta.label} via ${
          existing.source === "env" ? `${existing.envVar} env var` : "stored API key"
        }).`,
        "Long-term memory search, session dedup, and dream clustering are good to go.",
      ].join("\n"),
      "Memory embeddings",
    );
    if (existing.source === "env" && !config.agents?.defaults?.memorySearch?.provider) {
      return {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            memorySearch: {
              ...config.agents?.defaults?.memorySearch,
              provider: existing.provider,
            },
          },
        },
      };
    }
    return config;
  }

  await prompter.note(
    [
      "Bitterbot's biological memory system runs on vector embeddings.",
      "They turn MEMORY.md entries and past sessions into searchable recall,",
      "drive session extraction dedup, and cluster memories during dream cycles.",
      "",
      "Without a key, the agent still works — but it forgets across conversations.",
      "",
      "Recommended: OpenAI (cheapest + highest quality via text-embedding-3-small).",
      "Also supported: Gemini, Voyage AI.",
      "",
      "You can also set the key as an env var and skip this step:",
      "  OPENAI_API_KEY, GEMINI_API_KEY, or VOYAGE_API_KEY",
    ].join("\n"),
    "Memory embeddings",
  );

  const wantEmbeddings =
    flow === "quickstart"
      ? true
      : await prompter.confirm({
          message:
            "Set up a memory embeddings provider now? (highly recommended — otherwise long-term memory won't work)",
          initialValue: true,
        });

  if (!wantEmbeddings) {
    await prompter.note(
      [
        "Skipped. Set one up later via:",
        "  bitterbot configure --section memory",
        "Or export OPENAI_API_KEY / GEMINI_API_KEY / VOYAGE_API_KEY.",
      ].join("\n"),
      "Memory embeddings skipped",
    );
    return config;
  }

  const provider = (await prompter.select({
    message: "Which embedding provider?",
    options: Object.entries(PROVIDERS).map(([value, meta]) => ({
      value,
      label: meta.label,
      hint: meta.hint,
    })),
    initialValue: "openai",
  })) as EmbeddingProvider;

  const meta = PROVIDERS[provider];

  const keyInput = await prompter.text({
    message: `${meta.label} API key (or leave blank to use ${meta.envVars[0]} env var later)`,
    placeholder: meta.keyPlaceholder,
  });

  const key = String(keyInput ?? "").trim();

  const nextMemorySearch = {
    ...config.agents?.defaults?.memorySearch,
    provider,
    ...(key
      ? {
          remote: {
            ...config.agents?.defaults?.memorySearch?.remote,
            apiKey: key,
          },
        }
      : {}),
  };

  if (!key) {
    await prompter.note(
      [
        `No key entered. Set ${meta.envVars[0]} in the gateway environment before starting,`,
        "or re-run `bitterbot onboard` to paste one.",
        "Long-term memory search won't work until a key is available.",
      ].join("\n"),
      "Memory embeddings",
    );
  } else {
    await prompter.note(
      `${meta.label} embeddings configured. Long-term memory is live.`,
      "Memory embeddings ready",
    );
  }

  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        memorySearch: nextMemorySearch,
      },
    },
  };
}
