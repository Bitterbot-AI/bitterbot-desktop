// Defaults for agent metadata when upstream does not supply them.
// The runtime fallback when no model is configured at all. It matches the
// Anthropic model setup recommends (src/wizard/setup-keys.ts). pi-ai's static
// catalog predates Claude 5, so the runner resolves it through the family
// forward-compat clone (src/agents/model-forward-compat.ts), which borrows the
// newest catalogued Sonnet's limits and marks its price as borrowed.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-sonnet-5-5";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
