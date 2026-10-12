/**
 * The setup step model (PLAN-56 Phase 4): ONE list of steps, two renderers.
 *
 * The terminal QuickStart (`bitterbot onboard --no-browser`, src/wizard/onboarding.ts)
 * and the browser setup page (`wizard.*` RPCs, src/wizard/setup-wizard.ts) both
 * run `runSetupSteps` over `SETUP_STEPS` through the `WizardPrompter`
 * interface: the clack prompter draws it in the terminal, the RPC session
 * prompter (src/wizard/session.ts) hands each prompt to the browser. A step
 * added here appears in both; there is no second list to forget
 * (setup-steps.test.ts runs both renderers and compares what they asked).
 *
 * `bitterbot onboard --non-interactive` uses the same model with no prompter:
 * every step takes its recommended answer, the same answers the "Use
 * recommended defaults" fork accepts in one click.
 *
 * Steps only build a draft (config edits + a pending key). Nothing is written
 * until `commitSetupDraft`, so cancelling setup leaves no trace.
 *
 * Interactive runs start with the same explicit risk acknowledgement the
 * terminal wizard has always shown (`requireSetupRiskAcknowledgement`);
 * --non-interactive needs --accept-risk instead.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { InstallKind } from "../infra/install-kind.js";
import { applyLocalOnlyPreset } from "./onboarding.p2p.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";
import {
  type DetectedKey,
  detectSetupKeys,
  detectSignedInProfiles,
  describeKeySource,
  resolveDetectedKey,
  SETUP_PROVIDER_ORDER,
  SETUP_PROVIDERS,
  type SetupKeyEnv,
  type SetupKeySource,
  type SetupProvider,
  type SignedInProfile,
  storeProviderKey,
  validatePastedKey,
} from "./setup-keys.js";
import type { SetupServiceSupport } from "./setup-service.js";

export const SETUP_STEP_IDS = [
  "auth",
  "model",
  "embeddings",
  "webSearch",
  "channels",
  "p2p",
  "service",
  "telemetry",
] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** Approximate size of the bundled local embedding model (embeddinggemma-300m Q8_0). */
export const LOCAL_EMBEDDINGS_DOWNLOAD = "about 330 MB";

/**
 * What joining the mesh sends, in one sentence. docs/network/egress.md quotes
 * it verbatim (a test keeps the two identical).
 */
export const P2P_EGRESS_SENTENCE =
  "Joining the P2P network connects this node to the Bitterbot bootstrap relays and shares, " +
  "under its Ed25519 peer id: skill announcements, reputation scores and census pings; the text " +
  "of your agent's top curiosity question at most once per consolidation cycle; experience " +
  "scores (numbers only) once per dream cycle; and skills you mark shared or public.";

/** The risk acknowledgement, word for word what the terminal wizard shows. */
export const RISK_ACKNOWLEDGEMENT_TITLE = "Security — at your own risk";
export const RISK_ACKNOWLEDGEMENT_NOTE = [
  "Read this before going further.",
  "",
  "Bitterbot is in open beta. It remembers your life, runs real tools,",
  "moves real USDC, and talks to other agents on a live P2P mesh.",
  "That is the whole point — and it is also how you get hurt if you",
  "skip the safety rails.",
  "",
  "What this agent can actually do once you enable its tools:",
  "- Read and write files in its workspace",
  "- Run code, browse the web, execute shell commands",
  "- Send and receive messages on channels you connect (WhatsApp, Telegram, etc.)",
  "- Hold a USDC wallet on Base, pay for paywalled APIs via x402, receive payments",
  "- Publish skills to the P2P marketplace and ingest skills from other agents",
  "",
  "LLMs can be tricked. A malicious message, a hostile webpage, or a",
  "poisoned skill from the network can steer the agent toward actions",
  "you did not intend. Plan for that, not against it.",
  "",
  "Run Bitterbot at your own risk. We ship fast, patch fast, and trust",
  "operators to harden their own nodes. If basic security and access",
  "control are unfamiliar territory, pair with someone who can help",
  "before enabling tools, channels, or the wallet.",
  "",
  "Recommended baseline:",
  "- Pairing, allowlists, and mention gating for inbound messages.",
  "- Sandbox + least-privilege tools. Start minimal; expand as you trust it.",
  "- Keep secrets out of the agent's reachable filesystem (no .env in workspace).",
  "- Use the strongest model available for any bot with tools or untrusted inboxes.",
  "- Start the wallet with a small float you can afford to lose while you learn.",
  "- P2P skill ingestion defaults to 'review' — don't flip to 'auto' until you",
  "  have a trust list and understand the SkillVerifier + reputation gates.",
  "",
  "Run regularly:",
  "  bitterbot security audit --deep",
  "  bitterbot security audit --fix",
  "  bitterbot doctor",
  "",
  "Must read: https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/SECURITY.md",
].join("\n");
export const RISK_ACKNOWLEDGEMENT_CONFIRM =
  "I understand Bitterbot can act on my behalf, move funds, and connect to a live P2P network. I accept the risk. Continue?";

/**
 * The explicit risk acknowledgement both renderers show before any setup
 * choice. Declining cancels setup. There is no default "yes".
 */
export async function requireSetupRiskAcknowledgement(prompter: WizardPrompter): Promise<void> {
  await prompter.note(RISK_ACKNOWLEDGEMENT_NOTE, RISK_ACKNOWLEDGEMENT_TITLE, {
    data: { kind: "risk" },
  });
  const ok = await prompter.confirm({
    message: RISK_ACKNOWLEDGEMENT_CONFIRM,
    initialValue: false,
  });
  if (ok !== true) {
    throw new WizardCancelledError("risk not accepted");
  }
}

/** Where to go for sign-in methods the setup page does not offer. */
export const OTHER_SIGN_IN_HINT =
  "Codex (ChatGPT) OAuth, Anthropic setup tokens, Gemini, Bedrock, local and custom endpoints: " +
  "run `bitterbot onboard --no-browser --flow manual` in a terminal, or add them later in Settings.";

export const TELEMETRY_STATEMENT =
  "Bitterbot sends no telemetry to the project: no analytics, crash reports or usage pings, and " +
  "there is no account to create. Every outbound connection your node makes (the P2P items " +
  "above included, if you join) is listed with its off switch in docs/network/egress.md.";

const WEB_SEARCH_ENV: Array<{ provider: string; envVar: string; label: string }> = [
  { provider: "brave", envVar: "BRAVE_API_KEY", label: "Brave Search" },
  { provider: "tavily", envVar: "TAVILY_API_KEY", label: "Tavily" },
  { provider: "perplexity", envVar: "PERPLEXITY_API_KEY", label: "Perplexity" },
  { provider: "serply", envVar: "SERPLY_API_KEY", label: "Serply" },
];

export type SetupContext = {
  /** Effective config (load-time defaults applied): read current values here. */
  effective: BitterbotConfig;
  /** Keys setup may offer (names and masked suffixes only). */
  keys: DetectedKey[];
  /** Saved OAuth / token sign-ins, offered as "already signed in". */
  profiles?: SignedInProfile[];
  keyEnv: SetupKeyEnv;
  installKind: InstallKind;
  env?: NodeJS.ProcessEnv;
  /** Whether a background gateway service can be installed (undefined: not offered). */
  service?: SetupServiceSupport;
};

export type PendingKey = {
  provider: SetupProvider;
  value: string;
  source: SetupKeySource | "pasted";
};

export type SetupDraft = {
  /** The config file being built (no load-time defaults). */
  config: BitterbotConfig;
  provider?: SetupProvider;
  /** Written to the provider's secret location at commit, never before. */
  pendingKey?: PendingKey;
  /** A saved sign-in (OAuth / token) chosen instead of an API key. */
  authProfile?: { profileId: string; provider: string; mode: "oauth" | "token" };
  /** Install the gateway as a background service (the "service" step). */
  installService?: boolean;
  /** Messages for the user from committing (key backups, env warnings). */
  notices: string[];
  channelsNext: boolean;
  /** Answers per step, secrets excluded (for tests and the review screen). */
  answers: Partial<Record<SetupStepId, string>>;
};

type StepAnswer = { choice: string; secret?: string; webProvider?: string };

type SetupStepDef = {
  id: SetupStepId;
  title: string;
  /** False: the step does not apply here (not asked, not described); `skipped` is applied. */
  applies?: (ctx: SetupContext) => boolean;
  /** The answer recorded when the step does not apply. */
  skipped?: string;
  /** The answer "recommended defaults" and --non-interactive take; undefined = ask. */
  recommended: (ctx: SetupContext, draft: SetupDraft) => string | undefined;
  /** One line for the fork screen describing the recommended answer. */
  describe: (ctx: SetupContext, draft: SetupDraft) => string;
  ask: (ctx: SetupContext, draft: SetupDraft, prompter: WizardPrompter) => Promise<StepAnswer>;
  apply: (ctx: SetupContext, draft: SetupDraft, answer: StepAnswer) => void;
};

function keyLabel(key: DetectedKey): string {
  return `${SETUP_PROVIDERS[key.provider].label}: ${key.envVar} ${key.masked} (${describeKeySource(key.source)})`;
}

async function askPastedKey(
  prompter: WizardPrompter,
  provider: SetupProvider,
): Promise<string | null> {
  const meta = SETUP_PROVIDERS[provider];
  // Re-ask on a bad paste instead of failing the whole session (the RPC
  // prompter turns a `validate` failure into a session error).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await prompter.text({
      message: `${meta.label} API key (create one at ${meta.keyUrl})`,
      placeholder: meta.placeholder,
      sensitive: true,
    });
    const problem = validatePastedKey(value);
    if (!problem) {
      return value.trim();
    }
    await prompter.note(problem, "API key");
  }
  return null;
}

function setPrimaryModel(config: BitterbotConfig, model: string): BitterbotConfig {
  const models = config.agents?.defaults?.models;
  const withAllowlist =
    models && Object.keys(models).length > 0
      ? {
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              models: { ...models, [model]: { ...models[model] } },
            },
          },
        }
      : config;
  const current = withAllowlist.agents?.defaults?.model;
  const fallbacks =
    current && typeof current === "object" && Array.isArray(current.fallbacks)
      ? current.fallbacks
      : undefined;
  return {
    ...withAllowlist,
    agents: {
      ...withAllowlist.agents,
      defaults: {
        ...withAllowlist.agents?.defaults,
        model: { ...(fallbacks ? { fallbacks } : {}), primary: model },
      },
    },
  };
}

function currentPrimary(config: BitterbotConfig): string | undefined {
  const model = config.agents?.defaults?.model;
  if (typeof model === "string") {
    return model;
  }
  return model && typeof model === "object" ? model.primary : undefined;
}

function profileLabel(profile: SignedInProfile): string {
  const how = profile.mode === "oauth" ? "OAuth sign-in" : "token";
  return `Already signed in: ${profile.provider} (${how}, profile ${profile.profileId}${profile.email ? `, ${profile.email}` : ""})`;
}

function providerOfModel(model: string | undefined): string | undefined {
  return model?.includes("/") ? model.split("/")[0] : undefined;
}

/**
 * The credential to recommend: one for the provider of the model already
 * configured (a saved sign-in first), else the first key found, else a
 * saved sign-in. Undefined: nothing found, ask.
 */
function recommendedAuth(ctx: SetupContext, draft: SetupDraft): string | undefined {
  const profiles = ctx.profiles ?? [];
  const primaryProvider = providerOfModel(currentPrimary(draft.config));
  if (primaryProvider) {
    const profile = profiles.find((p) => p.provider === primaryProvider);
    if (profile) {
      return profile.id;
    }
    const key = ctx.keys.find((k) => k.provider === primaryProvider);
    if (key) {
      return key.id;
    }
  }
  return ctx.keys[0]?.id ?? profiles[0]?.id;
}

const authStep: SetupStepDef = {
  id: "auth",
  title: "Model provider key",
  recommended: (ctx, draft) => recommendedAuth(ctx, draft),
  describe: (ctx, draft) => {
    const rec = recommendedAuth(ctx, draft);
    const profile = ctx.profiles?.find((p) => p.id === rec);
    if (profile) {
      return `Model sign-in: ${profileLabel(profile)}`;
    }
    const key = ctx.keys.find((k) => k.id === rec);
    return key
      ? `Model key: ${keyLabel(key)}`
      : "Model key: none found yet, you will be asked for one";
  },
  ask: async (ctx, draft, prompter) => {
    const options = [
      ...(ctx.profiles ?? []).map((profile) => ({
        value: profile.id,
        label: profileLabel(profile),
        hint: "Keep using this sign-in",
      })),
      ...ctx.keys.map((key) => ({ value: key.id, label: keyLabel(key), hint: "Use this key" })),
      ...SETUP_PROVIDER_ORDER.map((provider) => ({
        value: `paste:${provider}`,
        label: `Paste a ${SETUP_PROVIDERS[provider].label} API key`,
        hint: SETUP_PROVIDERS[provider].keyUrl,
      })),
      {
        value: "other",
        label: "Other sign-in methods (Codex OAuth, Gemini, custom endpoints)",
        hint: "Set up in a terminal: bitterbot onboard --no-browser --flow manual",
      },
      {
        value: "skip",
        label: "Skip for now",
        hint: "Add a key later in Settings",
      },
    ];
    const choice = await prompter.select({
      message:
        ctx.keys.length > 0 || (ctx.profiles?.length ?? 0) > 0
          ? "Which key should your agent use? Keys found on this machine are listed by name; their values never leave the gateway."
          : "Your agent needs a model provider API key. Paste one, or skip and add it later.",
      options,
      initialValue: recommendedAuth(ctx, draft) ?? options[0]?.value,
    });
    if (choice === "other") {
      await prompter.note(OTHER_SIGN_IN_HINT, "Other sign-in methods");
      return { choice: "skip" };
    }
    if (typeof choice === "string" && choice.startsWith("paste:")) {
      const provider = choice.slice("paste:".length) as SetupProvider;
      if (!SETUP_PROVIDERS[provider]) {
        return { choice: "skip" };
      }
      const secret = await askPastedKey(prompter, provider);
      return secret ? { choice, secret } : { choice: "skip" };
    }
    return { choice: typeof choice === "string" ? choice : "skip" };
  },
  apply: (ctx, draft, answer) => {
    draft.provider = undefined;
    draft.pendingKey = undefined;
    draft.authProfile = undefined;
    if (answer.choice.startsWith("profile:")) {
      const profile = (ctx.profiles ?? []).find((p) => p.id === answer.choice);
      if (!profile) {
        draft.answers.auth = "skip";
        return;
      }
      draft.authProfile = {
        profileId: profile.profileId,
        provider: profile.provider,
        mode: profile.mode,
      };
      if (profile.provider in SETUP_PROVIDERS) {
        draft.provider = profile.provider as SetupProvider;
      }
      draft.answers.auth = profile.id;
      return;
    }
    if (answer.choice.startsWith("paste:") && answer.secret) {
      const provider = answer.choice.slice("paste:".length) as SetupProvider;
      if (!SETUP_PROVIDERS[provider]) {
        draft.answers.auth = "skip";
        return;
      }
      draft.provider = provider;
      draft.pendingKey = { provider, value: answer.secret, source: "pasted" };
      draft.answers.auth = `pasted:${provider}`;
      return;
    }
    const detected =
      answer.choice === "skip" ? null : resolveDetectedKey(answer.choice, ctx.keyEnv);
    if (!detected) {
      draft.answers.auth = "skip";
      return;
    }
    draft.provider = detected.provider;
    draft.pendingKey = {
      provider: detected.provider,
      value: detected.value,
      source: detected.source,
    };
    draft.answers.auth = detected.id;
  },
};

const modelStep: SetupStepDef = {
  id: "model",
  title: "Model",
  // A model already in the config file is kept unless the user picks
  // another one: recommended defaults and --non-interactive never replace it.
  recommended: (_ctx, draft) => {
    if (!draft.provider || currentPrimary(draft.config)) {
      return "keep";
    }
    return SETUP_PROVIDERS[draft.provider].models[0]?.id;
  },
  describe: (ctx, draft) => {
    const provider = draft.provider ?? ctx.keys[0]?.provider;
    const rec = provider
      ? modelStep.recommended(ctx, { ...draft, provider })
      : modelStep.recommended(ctx, draft);
    return `Model: ${rec && rec !== "keep" ? rec : "the provider's recommended model"}`;
  },
  ask: async (ctx, draft, prompter) => {
    if (!draft.provider) {
      await prompter.note(
        "No model provider key yet, so there is no model to pick. Add a key and choose a model later in Settings.",
        "Model",
      );
      return { choice: "keep" };
    }
    const models = SETUP_PROVIDERS[draft.provider].models;
    const primary = currentPrimary(draft.config);
    const options = [
      ...(primary
        ? [{ value: "keep", label: `Keep the current model (${primary})`, hint: "No change" }]
        : []),
      ...models.map((m) => ({ value: m.id, label: m.label, hint: `${m.id}: ${m.hint}` })),
    ];
    const choice = await prompter.select({
      message: `Which ${SETUP_PROVIDERS[draft.provider].label} model?`,
      options,
      initialValue: modelStep.recommended(ctx, draft),
    });
    return { choice: typeof choice === "string" ? choice : (models[0]?.id ?? "keep") };
  },
  apply: (_ctx, draft, answer) => {
    if (!draft.provider || answer.choice === "keep") {
      draft.answers.model = "keep";
      return;
    }
    const allowed = SETUP_PROVIDERS[draft.provider].models.map((m) => m.id);
    if (!allowed.includes(answer.choice)) {
      // Not a model this provider offers here: leave the config alone.
      draft.answers.model = "keep";
      return;
    }
    const model = answer.choice;
    draft.config = setPrimaryModel(draft.config, model);
    draft.answers.model = model;
  },
};

const embeddingsStep: SetupStepDef = {
  id: "embeddings",
  title: "Memory embeddings",
  recommended: (ctx) => (ctx.effective.agents?.defaults?.memorySearch?.provider ? "keep" : "auto"),
  describe: (ctx) =>
    embeddingsStep.recommended(ctx, {} as SetupDraft) === "keep"
      ? "Memory: keep your current embeddings provider"
      : `Memory: local embedding model (${LOCAL_EMBEDDINGS_DOWNLOAD}, downloaded on first use)`,
  ask: async (ctx, draft, prompter) => {
    const current = ctx.effective.agents?.defaults?.memorySearch?.provider;
    const options = [
      ...(current
        ? [{ value: "keep", label: `Keep the current provider (${current})`, hint: "No change" }]
        : []),
      {
        value: "auto",
        label: "Local model (recommended)",
        hint: `${LOCAL_EMBEDDINGS_DOWNLOAD}, downloaded on first use, runs on this machine; a remote embeddings key added later takes over`,
      },
      {
        value: "local",
        label: "Always the local model",
        hint: `${LOCAL_EMBEDDINGS_DOWNLOAD}, never a remote provider`,
      },
      ...(draft.provider === "openai"
        ? [
            {
              value: "openai",
              label: "OpenAI embeddings",
              hint: "Uses your OpenAI key; no download",
            },
          ]
        : []),
    ];
    const choice = await prompter.select({
      message:
        "Long-term memory search runs on embeddings. The local model needs no key and keeps your notes on this machine.",
      options,
      initialValue: embeddingsStep.recommended(ctx, draft),
    });
    return { choice: typeof choice === "string" ? choice : "auto" };
  },
  apply: (_ctx, draft, answer) => {
    const known = ["keep", "auto", "local", "openai"];
    draft.answers.embeddings = known.includes(answer.choice) ? answer.choice : "auto";
    if (answer.choice !== "local" && answer.choice !== "openai") {
      return;
    }
    if (answer.choice === "openai" && draft.provider !== "openai") {
      draft.answers.embeddings = "auto";
      return;
    }
    draft.config = {
      ...draft.config,
      agents: {
        ...draft.config.agents,
        defaults: {
          ...draft.config.agents?.defaults,
          memorySearch: {
            ...draft.config.agents?.defaults?.memorySearch,
            provider: answer.choice as "local" | "openai",
          },
        },
      },
    };
  },
};

function detectSearchEnv(env: NodeJS.ProcessEnv) {
  return WEB_SEARCH_ENV.find((entry) => env[entry.envVar]?.trim());
}

const webSearchStep: SetupStepDef = {
  id: "webSearch",
  title: "Web search (optional)",
  recommended: (ctx) => {
    if (ctx.effective.tools?.web?.search?.provider) {
      return "keep";
    }
    const found = detectSearchEnv(ctx.env ?? process.env);
    return found ? `env:${found.provider}` : "later";
  },
  describe: (ctx) => {
    const rec = webSearchStep.recommended(ctx, {} as SetupDraft);
    if (rec === "keep") {
      return "Web search: keep your current provider";
    }
    return rec?.startsWith("env:")
      ? `Web search: ${rec.slice(4)} (key found in the environment)`
      : "Web search: later (curiosity research stays off until a provider is set)";
  },
  ask: async (ctx, draft, prompter) => {
    const found = detectSearchEnv(ctx.env ?? process.env);
    const options = [
      ...(ctx.effective.tools?.web?.search?.provider
        ? [{ value: "keep", label: "Keep the current provider", hint: "No change" }]
        : []),
      ...(found
        ? [
            {
              value: `env:${found.provider}`,
              label: `${found.label} (${found.envVar} is set)`,
              hint: "Use it",
            },
          ]
        : []),
      { value: "later", label: "Later", hint: "Add a provider in Settings when you want it" },
      { value: "parallel", label: "Parallel Search", hint: "Free, no key needed" },
      {
        value: "paste:brave",
        label: "Paste a Brave Search key",
        hint: "Free tier: https://brave.com/search/api/",
      },
      { value: "paste:tavily", label: "Paste a Tavily key", hint: "https://tavily.com" },
    ];
    const choice = await prompter.select({
      message:
        "Optional: web search lets the agent look things up online. Curiosity research (the agent following up its own open questions on a schedule) needs it.",
      options,
      initialValue: webSearchStep.recommended(ctx, draft),
    });
    const value = typeof choice === "string" ? choice : "later";
    if (value.startsWith("paste:")) {
      const provider = value.slice("paste:".length);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const key = await prompter.text({
          message: `${provider === "brave" ? "Brave Search" : "Tavily"} API key`,
          sensitive: true,
        });
        const problem = validatePastedKey(key);
        if (!problem) {
          return { choice: value, secret: key.trim(), webProvider: provider };
        }
        await prompter.note(problem, "Web search");
      }
      return { choice: "later" };
    }
    return { choice: value };
  },
  apply: (ctx, draft, answer) => {
    const search = draft.config.tools?.web?.search;
    type WebSearchConfig = NonNullable<NonNullable<BitterbotConfig["tools"]>["web"]>["search"];
    const write = (next: Record<string, unknown>) => {
      draft.config = {
        ...draft.config,
        tools: {
          ...draft.config.tools,
          web: {
            ...draft.config.tools?.web,
            search: { ...search, ...next } as WebSearchConfig,
          },
        },
      };
    };
    if (answer.choice === "parallel") {
      write({ provider: "parallel", enabled: true });
      draft.answers.webSearch = "parallel";
    } else if (
      answer.choice.startsWith("env:") &&
      answer.choice === `env:${detectSearchEnv(ctx.env ?? process.env)?.provider ?? ""}`
    ) {
      // Only the provider whose key is actually in the environment. The key
      // stays there; only the provider choice is saved.
      write({ provider: answer.choice.slice(4), enabled: true });
      draft.answers.webSearch = answer.choice;
    } else if (
      answer.choice.startsWith("paste:") &&
      answer.secret &&
      (answer.webProvider === "brave" || answer.webProvider === "tavily")
    ) {
      // Same place the terminal web-search step stores a pasted key.
      const provider = answer.webProvider;
      if (provider === "brave") {
        write({ provider, enabled: true, apiKey: answer.secret });
      } else {
        const block = (search as Record<string, unknown> | undefined)?.[provider];
        write({
          provider,
          enabled: true,
          [provider]: { ...(block as Record<string, unknown> | undefined), apiKey: answer.secret },
        });
      }
      draft.answers.webSearch = `pasted:${provider}`;
    } else {
      draft.answers.webSearch = answer.choice === "keep" ? "keep" : "later";
    }
  },
};

const channelsStep: SetupStepDef = {
  id: "channels",
  title: "Chat channels",
  recommended: () => "later",
  describe: () => "Channels: later (chat in the Control UI right away)",
  ask: async (_ctx, _draft, prompter) => {
    const choice = await prompter.select({
      message:
        "You can chat with your agent in the Control UI right away. WhatsApp, Telegram, Discord, Signal and Slack can be connected any time.",
      options: [
        {
          value: "later",
          label: "Later",
          hint: "Connect from the Channels page or `bitterbot channels add`",
        },
        {
          value: "now",
          label: "Right after setup",
          hint: "Go straight to channel setup when this finishes",
        },
      ],
      initialValue: "later",
    });
    return { choice: choice === "now" ? "now" : "later" };
  },
  apply: (_ctx, draft, answer) => {
    draft.channelsNext = answer.choice === "now";
    draft.answers.channels = draft.channelsNext ? "now" : "later";
  },
};

function p2pEnabled(config: BitterbotConfig): boolean {
  return config.p2p?.enabled !== false;
}

const p2pStep: SetupStepDef = {
  id: "p2p",
  title: "P2P network",
  // The current value, never a new default (p2p.enabled default: PLAN-56 D2).
  recommended: (ctx) => (p2pEnabled(ctx.effective) ? "join" : "local"),
  describe: (ctx) =>
    p2pEnabled(ctx.effective)
      ? `P2P network: join (the current setting). ${P2P_EGRESS_SENTENCE}`
      : "P2P network: stay local-only (the current setting)",
  ask: async (ctx, draft, prompter) => {
    const choice = await prompter.select({
      message: `${P2P_EGRESS_SENTENCE} Every outbound connection and its off switch: docs/network/egress.md.`,
      options: [
        {
          value: "join",
          label: "Join the P2P network",
          hint: "Skill sharing and circles; leave any time",
        },
        {
          value: "local",
          label: "Local-only",
          hint: "P2P, circles, agent-to-agent HTTP, update check on start and live model discovery off",
        },
      ],
      initialValue: p2pStep.recommended(ctx, draft),
    });
    return { choice: choice === "local" ? "local" : "join" };
  },
  apply: (ctx, draft, answer) => {
    draft.answers.p2p = answer.choice;
    const currentlyOn = p2pEnabled(ctx.effective);
    if (answer.choice === "local" && currentlyOn) {
      draft.config = applyLocalOnlyPreset(draft.config);
    } else if (answer.choice === "join" && !currentlyOn) {
      draft.config = { ...draft.config, p2p: { ...draft.config.p2p, enabled: true } };
    }
  },
};

const serviceStep: SetupStepDef = {
  id: "service",
  title: "Keep running",
  // Offered exactly where the terminal QuickStart installs a service: not in
  // a container, not on Linux without systemd user services, not when one is
  // already installed (src/wizard/onboarding.finalize.ts).
  applies: (ctx) => ctx.service?.kind === "available",
  skipped: "n/a",
  recommended: () => "install",
  describe: (ctx) =>
    `Background service: install it (${ctx.service?.kind === "available" ? ctx.service.label : "service"}), so Bitterbot keeps running and starts on login`,
  ask: async (ctx, _draft, prompter) => {
    const label = ctx.service?.kind === "available" ? ctx.service.label : "service";
    const choice = await prompter.select({
      message:
        "Keep Bitterbot running in the background? Dreams, curiosity and channels work only while the gateway runs.",
      options: [
        {
          value: "install",
          label: "Keep Bitterbot running in the background (start on login)",
          hint: `Installs a ${label}; remove it any time with \`bitterbot gateway uninstall\``,
        },
        {
          value: "no",
          label: "No, I will start it myself",
          hint: "Run `bitterbot gateway` when you want it",
        },
      ],
      initialValue: "install",
    });
    return { choice: choice === "no" ? "no" : "install" };
  },
  apply: (ctx, draft, answer) => {
    if (
      ctx.service?.kind !== "available" ||
      (answer.choice !== "install" && answer.choice !== "no")
    ) {
      draft.installService = false;
      draft.answers.service = ctx.service?.kind === "installed" ? "installed" : "n/a";
      return;
    }
    draft.installService = answer.choice === "install";
    draft.answers.service = answer.choice;
  },
};

const telemetryStep: SetupStepDef = {
  id: "telemetry",
  title: "Privacy",
  recommended: () => "ack",
  describe: () => TELEMETRY_STATEMENT,
  ask: async (_ctx, _draft, prompter) => {
    await prompter.note(TELEMETRY_STATEMENT, "No telemetry, no account");
    return { choice: "ack" };
  },
  apply: (_ctx, draft) => {
    draft.answers.telemetry = "ack";
  },
};

/** THE step list. Both renderers and --non-interactive run exactly this. */
export const SETUP_STEPS: readonly SetupStepDef[] = [
  authStep,
  modelStep,
  embeddingsStep,
  webSearchStep,
  channelsStep,
  p2pStep,
  serviceStep,
  telemetryStep,
];

export function createSetupDraft(config: BitterbotConfig): SetupDraft {
  return { config: structuredClone(config), channelsNext: false, answers: {}, notices: [] };
}

/** Re-read the keys and sign-ins setup can offer (after a commit moved one). */
export function refreshSetupCredentials(ctx: SetupContext): void {
  ctx.keys = detectSetupKeys(ctx.keyEnv);
  ctx.profiles = detectSignedInProfiles(ctx.keyEnv.agentDir);
}

export type SetupRunMode = "interactive" | "non-interactive";

/**
 * Run the steps. Interactive runs open with the "recommended defaults" fork;
 * accepting it applies every recommended answer and asks only what has none
 * (a model key when none was found). `only` re-runs a subset (setup's
 * "back" after a failed first reply). `presets` pins answers from CLI flags.
 */
export async function runSetupSteps(params: {
  ctx: SetupContext;
  draft: SetupDraft;
  prompter?: WizardPrompter;
  only?: readonly SetupStepId[];
  presets?: Partial<Record<SetupStepId, string>>;
  /** Skip the fork and walk every step (tests, "back"). */
  skipFork?: boolean;
  /**
   * Skip the fork and take every recommended answer. Only for runs nobody
   * can answer (no TTY); an interactive terminal always sees the fork.
   */
  acceptRecommended?: boolean;
  /**
   * The risk acknowledgement already happened (the terminal wizard asks at
   * its start; --non-interactive requires --accept-risk). Otherwise an
   * interactive run asks it first.
   */
  riskAcknowledged?: boolean;
}): Promise<SetupDraft> {
  const { ctx, draft, prompter } = params;
  if (prompter && !params.riskAcknowledged && !params.only) {
    await requireSetupRiskAcknowledgement(prompter);
  }
  const applicable = SETUP_STEPS.filter((step) => !step.applies || step.applies(ctx));
  const steps = SETUP_STEPS.filter((step) => !params.only || params.only.includes(step.id));
  const askedSteps = steps.filter((step) => !step.applies || step.applies(ctx));
  let useRecommended = !prompter || params.acceptRecommended === true;
  if (prompter && !useRecommended && !params.skipFork && !params.only) {
    const lines = applicable.map((step) => `- ${step.describe(ctx, draft)}`);
    const fork = await prompter.select({
      message: [
        "Recommended defaults:",
        ...lines,
        "",
        "Bitterbot can run tools and act for you once connected; read SECURITY.md before enabling channels or the wallet.",
      ].join("\n"),
      options: [
        {
          value: "recommended",
          label: "Use recommended defaults",
          hint: "One click; change anything later in Settings",
        },
        { value: "custom", label: "Choose each step", hint: `${applicable.length} short steps` },
      ],
      initialValue: "recommended",
    });
    useRecommended = fork !== "custom";
  }
  for (const step of steps) {
    if (step.applies && !step.applies(ctx)) {
      step.apply(ctx, draft, { choice: step.skipped ?? "n/a" });
      continue;
    }
    const index = askedSteps.indexOf(step);
    const preset = params.presets?.[step.id];
    const recommended = step.recommended(ctx, draft);
    let answer: StepAnswer;
    if (preset !== undefined) {
      answer = { choice: preset };
    } else if (useRecommended && recommended !== undefined) {
      answer = { choice: recommended };
    } else if (prompter) {
      prompter.section?.({
        id: step.id,
        title: step.title,
        index: index + 1,
        total: askedSteps.length,
      });
      answer = await step.ask(ctx, draft, prompter);
      prompter.section?.(null);
    } else {
      // Non-interactive with no recommendation (no key found): skip it.
      answer = { choice: step.id === "auth" ? "skip" : "keep" };
    }
    step.apply(ctx, draft, answer);
  }
  return draft;
}

/**
 * Write the chosen provider key to its normal secret location (once) and
 * return the config pointing at it. Clears the pending key either way.
 */
export async function commitSetupKey(
  draft: SetupDraft,
  ctx: SetupContext,
  opts?: { persistEnvironmentKey?: boolean },
): Promise<void> {
  if (draft.authProfile) {
    // A saved sign-in: nothing to write but the config pointer.
    const { applyAuthProfileConfig } = await import("../commands/onboard-auth.js");
    draft.config = applyAuthProfileConfig(draft.config, draft.authProfile);
    return;
  }
  const pending = draft.pendingKey;
  if (!pending) {
    return;
  }
  draft.config = await storeProviderKey({
    provider: pending.provider,
    key: pending.value,
    source: pending.source,
    config: draft.config,
    env: ctx.env,
    agentDir: ctx.keyEnv.agentDir,
    persistEnvironmentKey: opts?.persistEnvironmentKey,
    onNotice: (message) => draft.notices.push(message),
  });
  draft.pendingKey = undefined;
}

/** True when the draft has a credential the first reply can use. */
export function draftHasCredential(draft: SetupDraft): boolean {
  return Boolean(draft.provider || draft.authProfile);
}
