/**
 * Provider key detection and storage for setup (PLAN-56 Phase 4).
 *
 * Setup offers the keys it can already see, by NAME and a masked suffix only
 * ("ANTHROPIC_API_KEY ...9f2c from the gateway environment"). A key value never
 * leaves this module except into the normal secret location: the browser
 * answers with an option id such as `env:ANTHROPIC_API_KEY`, and the gateway
 * resolves the value itself.
 *
 * "Ask once, remember": the chosen key is written once to where the rest of
 * Bitterbot keeps that provider's key (the same writers the terminal wizard
 * uses), so the next setup finds it as a saved key and does not ask again.
 *
 *   - Anthropic, OpenRouter: the auth profile store (`auth-profiles.json`,
 *     profile `<provider>:default`).
 *   - OpenAI: `~/.bitterbot/.env` (`OPENAI_API_KEY`), which the gateway loads at
 *     start (src/infra/dotenv.ts).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { BitterbotConfig } from "../config/config.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import { resolveConfigDir } from "../utils.js";

export type SetupProvider = "anthropic" | "openai" | "openrouter";

export type SetupModelOption = { id: string; label: string; hint: string };

export const SETUP_PROVIDERS: Record<
  SetupProvider,
  {
    label: string;
    envVar: string;
    /** Where a new key is created. */
    keyUrl: string;
    placeholder: string;
    /** The provider's recommended model first. */
    models: SetupModelOption[];
  }
> = {
  anthropic: {
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-api03-...",
    models: [
      {
        id: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
        label: "Claude Opus 4.8",
        hint: "Most capable (recommended)",
      },
      {
        id: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        hint: "Balanced speed and cost",
      },
      { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fastest, cheapest" },
    ],
  },
  openai: {
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-...",
    models: [
      { id: "openai/gpt-5.1-codex", label: "GPT-5.1 Codex", hint: "Recommended" },
      { id: "openai/gpt-5.2", label: "GPT-5.2", hint: "General purpose" },
      { id: "openai/gpt-5-mini", label: "GPT-5 mini", hint: "Fastest, cheapest" },
    ],
  },
  openrouter: {
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-...",
    models: [
      {
        id: "openrouter/auto",
        label: "OpenRouter Auto",
        hint: "OpenRouter picks a model per request (recommended)",
      },
    ],
  },
};

export const SETUP_PROVIDER_ORDER: SetupProvider[] = ["anthropic", "openai", "openrouter"];

export type SetupKeySource = "environment" | "env-file" | "saved";

/** What setup may show about a key: never the value. */
export type DetectedKey = {
  /** Option id the renderer answers with, e.g. `env:ANTHROPIC_API_KEY`. */
  id: string;
  provider: SetupProvider;
  envVar: string;
  source: SetupKeySource;
  /** e.g. "...9f2c" (the last four characters), or "..." for a short value. */
  masked: string;
};

/** Mask a key down to its last four characters; short values show nothing. */
export function maskKeySuffix(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 12) {
    return "...";
  }
  return `...${trimmed.slice(-4)}`;
}

export function describeKeySource(source: SetupKeySource): string {
  switch (source) {
    case "environment":
      return "gateway environment";
    case "env-file":
      return "~/.bitterbot/.env";
    case "saved":
      return "saved by an earlier setup";
  }
}

export type SetupKeyEnv = {
  env?: NodeJS.ProcessEnv;
  /** `~/.bitterbot/.env` (or BITTERBOT_STATE_DIR/.env). */
  envFilePath?: string;
  /** Agent dir for the auth profile store (tests). */
  agentDir?: string;
};

function envFilePathFor(opts: SetupKeyEnv): string {
  return opts.envFilePath ?? path.join(resolveConfigDir(opts.env ?? process.env), ".env");
}

function readEnvFile(file: string): Record<string, string> {
  try {
    return dotenv.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function readSavedKey(provider: SetupProvider, agentDir?: string): string | null {
  if (provider === "openai") {
    // OpenAI keys are saved in the shared .env, covered by the env-file source.
    return null;
  }
  try {
    const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
    const cred = store.profiles[`${provider}:default`];
    if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key.trim()) {
      return cred.key.trim();
    }
  } catch {
    // No store yet.
  }
  return null;
}

type ResolvedKey = DetectedKey & { value: string };

function collectKeys(opts: SetupKeyEnv): ResolvedKey[] {
  const env = opts.env ?? process.env;
  const fileVars = readEnvFile(envFilePathFor(opts));
  const out: ResolvedKey[] = [];
  const seen = new Set<string>();
  const push = (key: Omit<ResolvedKey, "masked">) => {
    const value = key.value.trim();
    if (!value) {
      return;
    }
    // The same value from two places is one key: offer it once.
    const fingerprint = `${key.provider}:${crypto.createHash("sha256").update(value).digest("hex")}`;
    if (seen.has(fingerprint)) {
      return;
    }
    seen.add(fingerprint);
    out.push({ ...key, value, masked: maskKeySuffix(value) });
  };
  for (const provider of SETUP_PROVIDER_ORDER) {
    const envVar = SETUP_PROVIDERS[provider].envVar;
    const saved = readSavedKey(provider, opts.agentDir);
    if (saved) {
      push({ id: `saved:${provider}`, provider, envVar, source: "saved", value: saved });
    }
    const fromFile = fileVars[envVar];
    if (fromFile) {
      push({ id: `file:${envVar}`, provider, envVar, source: "env-file", value: fromFile });
    }
    const fromEnv = env[envVar];
    if (fromEnv) {
      push({ id: `env:${envVar}`, provider, envVar, source: "environment", value: fromEnv });
    }
  }
  return out;
}

/** Keys setup can offer, without their values. */
export function detectSetupKeys(opts: SetupKeyEnv = {}): DetectedKey[] {
  return collectKeys(opts).map(({ value: _value, ...rest }) => rest);
}

/** Server side only: the value behind a detected key's option id. */
export function resolveDetectedKey(
  id: string,
  opts: SetupKeyEnv = {},
): (DetectedKey & { value: string }) | null {
  return collectKeys(opts).find((key) => key.id === id) ?? null;
}

/** A pasted key that is obviously not a key (empty, whitespace, a URL). */
export function validatePastedKey(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return "Paste the key, or go back and choose Skip.";
  }
  if (/\s/.test(value)) {
    return "A key has no spaces; check the paste.";
  }
  if (value.length < 12) {
    return "That looks too short for an API key.";
  }
  return undefined;
}

/**
 * Write the key to the provider's normal secret location (once) and point the
 * config at it. `source: "saved"` keys are already stored; nothing is rewritten.
 */
export async function storeProviderKey(params: {
  provider: SetupProvider;
  key: string;
  source: SetupKeySource | "pasted";
  config: BitterbotConfig;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): Promise<BitterbotConfig> {
  const { provider, source } = params;
  const key = params.key.trim();
  const {
    applyAuthProfileConfig,
    applyOpenrouterProviderConfig,
    setAnthropicApiKey,
    setOpenrouterApiKey,
  } = await import("../commands/onboard-auth.js");
  if (provider === "openai") {
    const env = params.env ?? process.env;
    if (source !== "env-file") {
      upsertSharedEnvVar({ key: "OPENAI_API_KEY", value: key, env });
    }
    // The running gateway reads provider keys from its environment.
    process.env.OPENAI_API_KEY = key;
    const { applyOpenAIProviderConfig } = await import("../commands/openai-model-default.js");
    return applyOpenAIProviderConfig(params.config);
  }
  if (source !== "saved") {
    // The terminal wizard's writers: `<provider>:default` in the agent's
    // auth profile store, where the gateway looks on every turn.
    if (provider === "anthropic") {
      await setAnthropicApiKey(key, params.agentDir);
    } else {
      await setOpenrouterApiKey(key, params.agentDir);
    }
  }
  const withProfile = applyAuthProfileConfig(params.config, {
    profileId: `${provider}:default`,
    provider,
    mode: "api_key",
  });
  return provider === "openrouter" ? applyOpenrouterProviderConfig(withProfile) : withProfile;
}
