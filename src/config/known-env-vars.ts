/**
 * Environment variables Bitterbot itself reads for credentials: provider API
 * keys (model auth), channel tokens, the gateway's own auth, wallet, search
 * and cloud keys. Model auth reads the provider lists from here, the config
 * loader's login-shell import uses SHELL_ENV_EXPECTED_KEYS, and `bitterbot
 * gateway switch` uses KNOWN_CREDENTIAL_ENV to tell which variables of an
 * old gateway process matter. known-env-vars.test.ts greps the code for
 * credential-looking `process.env.*` names so this list cannot silently drift.
 */

/**
 * Providers whose key can come from several variables, in the order model
 * auth tries them (the first one set wins).
 */
export const PROVIDER_API_KEY_ENV_CHAINS: Readonly<Record<string, readonly string[]>> = {
  "github-copilot": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  chutes: ["CHUTES_OAUTH_TOKEN", "CHUTES_API_KEY"],
  zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
  opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
  "qwen-portal": ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"],
  "minimax-portal": ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY", "KIMICODE_API_KEY"],
  huggingface: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
};

/** Provider id -> the API key variable model auth reads for it. */
export const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  voyage: "VOYAGE_API_KEY",
  groq: "GROQ_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  litellm: "LITELLM_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_AI_GATEWAY_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  minimax: "MINIMAX_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  synthetic: "SYNTHETIC_API_KEY",
  venice: "VENICE_API_KEY",
  nearai: "NEARAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  opencode: "OPENCODE_API_KEY",
  together: "TOGETHER_API_KEY",
  qianfan: "QIANFAN_API_KEY",
  ollama: "OLLAMA_API_KEY",
  vllm: "VLLM_API_KEY",
};

/** Keys the config loader expects it may import from a login shell. */
export const SHELL_ENV_EXPECTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "MINIMAX_API_KEY",
  "SYNTHETIC_API_KEY",
  "NEARAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "BITTERBOT_GATEWAY_TOKEN",
  "BITTERBOT_GATEWAY_PASSWORD",
];

/** Other credentials read straight from the environment (channels, wallet, search, cloud). */
const OTHER_CREDENTIAL_ENV = [
  // channels
  "SLACK_USER_TOKEN",
  "DISCORD_TOKEN",
  "BITTERBOT_TWITCH_ACCESS_TOKEN",
  "BITTERBOT_X_ACCESS_TOKEN",
  // wallet and payments
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
  "STRIPE_SECRET_KEY",
  "PRIVACY_API_KEY",
  // search and tools
  "BRAVE_API_KEY",
  "PERPLEXITY_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "SERPLY_API_KEY",
  "KEENABLE_API_KEY",
  "PARALLEL_API_KEY",
  "GOOGLE_API_KEY",
  "GROK_API_KEY",
  "XI_API_KEY",
  "CUSTOM_API_KEY",
  "CHUTES_CLIENT_SECRET",
  // git hosting
  "GITHUB_TOKEN",
  "GH_TOKEN",
  // AWS (Bedrock)
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
];

/** Every credential variable above (BITTERBOT_* settings are matched by prefix). */
export const KNOWN_CREDENTIAL_ENV: ReadonlySet<string> = new Set([
  ...Object.values(PROVIDER_API_KEY_ENV),
  ...Object.values(PROVIDER_API_KEY_ENV_CHAINS).flat(),
  ...SHELL_ENV_EXPECTED_KEYS,
  ...OTHER_CREDENTIAL_ENV,
]);
