import { normalizeProviderId } from "./model-selection.js";

/**
 * Providers that used to work through pi-ai but were removed upstream
 * (pi-ai 0.71: Google Gemini CLI and Google Antigravity OAuth). They are no
 * longer offered; existing auth data is left alone, but any model on them is
 * refused with a clear message instead of a transport error mid-turn.
 */
export const RETIRED_PROVIDERS: Readonly<Record<string, string>> = {
  "google-gemini-cli": "Google Gemini CLI OAuth",
  "google-antigravity": "Google Antigravity OAuth",
};

export function retiredProviderLabel(provider: string | undefined): string | undefined {
  if (!provider) {
    return undefined;
  }
  return RETIRED_PROVIDERS[normalizeProviderId(provider)];
}

export function retiredProviderError(provider: string, modelId: string): string | undefined {
  const label = retiredProviderLabel(provider);
  if (!label) {
    return undefined;
  }
  return `${provider}/${modelId}: ${label} is no longer supported (removed upstream). Switch this model to the Gemini API key provider (google/...) via \`bitterbot configure\`.`;
}
