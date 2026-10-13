/**
 * Environment variables Bitterbot itself reads for credentials: provider API
 * keys (model auth), channel tokens, the gateway's own auth, wallet and
 * search keys. One list, so tools that look at an environment (the shell-env
 * import, `bitterbot gateway switch`) agree on what counts as "ours".
 */

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

/** Other credentials read straight from the environment (wallet, search, hubs). */
const OTHER_CREDENTIAL_ENV = [
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
  "BRAVE_API_KEY",
  "PERPLEXITY_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "SERPLY_API_KEY",
  "GOOGLE_API_KEY",
  "GITHUB_TOKEN",
  "HF_TOKEN",
  "HUGGINGFACE_HUB_TOKEN",
  "KIMI_API_KEY",
  "KIMICODE_API_KEY",
  "ZAI_API_KEY",
];

/** Every credential variable above (BITTERBOT_* settings are matched by prefix). */
export const KNOWN_CREDENTIAL_ENV: ReadonlySet<string> = new Set([
  ...Object.values(PROVIDER_API_KEY_ENV),
  ...SHELL_ENV_EXPECTED_KEYS,
  ...OTHER_CREDENTIAL_ENV,
]);
