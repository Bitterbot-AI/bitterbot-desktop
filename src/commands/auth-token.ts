import { normalizeProviderId } from "../agents/model-selection.js";

export const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
export const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80;
export const DEFAULT_TOKEN_PROFILE_NAME = "default";

export function normalizeTokenProfileName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_TOKEN_PROFILE_NAME;
  }
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || DEFAULT_TOKEN_PROFILE_NAME;
}

export function buildTokenProfileId(params: { provider: string; name: string }): string {
  const provider = normalizeProviderId(params.provider);
  const name = normalizeTokenProfileName(params.name);
  return `${provider}:${name}`;
}

export function validateAnthropicSetupToken(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Required";
  }
  // Common mistake: user pastes an API key (sk-ant-api03-...) where a
  // setup-token (sk-ant-oat01-...) is expected. Since 2026-04-04, setup-tokens
  // no longer work for third-party tools — API keys are the correct path.
  if (trimmed.startsWith("sk-ant-api")) {
    return (
      "That's an Anthropic API key, which is what you actually need — but " +
      "this prompt expects a setup-token. Cancel and re-run the wizard with " +
      "the 'Anthropic API key' option. (Note: setup-tokens are deprecated " +
      "for third-party tools as of 2026-04-04.)"
    );
  }
  if (!trimmed.startsWith(ANTHROPIC_SETUP_TOKEN_PREFIX)) {
    return `Expected a setup-token starting with ${ANTHROPIC_SETUP_TOKEN_PREFIX} — but note setup-tokens no longer work for 3rd-party tools. Cancel and use the API key flow instead.`;
  }
  if (trimmed.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH) {
    return "Token looks too short; paste the full setup-token";
  }
  return undefined;
}
