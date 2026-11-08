/**
 * PLAN-34 Phase 2 adversarial fix: known LOCAL model-spec providers. A
 * depersonalization model must resolve to one of these for autonomous
 * research egress to activate — otherwise the verbatim private note would
 * be sent to a cloud API. Conservative allowlist; unknown providers are
 * treated as non-local (fail closed).
 */
const LOCAL_MODEL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "llamacpp",
  "llama-cpp",
  "local",
  "localai",
  "localhost",
  "jan",
  "gpt4all",
]);

export function isLocalModelSpec(spec?: string): boolean {
  if (!spec) {
    return false;
  }
  const provider = spec.split("/")[0]?.trim().toLowerCase() ?? "";
  return LOCAL_MODEL_PROVIDERS.has(provider);
}
