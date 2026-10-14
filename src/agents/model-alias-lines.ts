import type { BitterbotConfig } from "../config/config.js";
import { resolveFamilyAliasTarget } from "./model-family-latest.js";

export function buildModelAliasLines(cfg?: BitterbotConfig) {
  const models = cfg?.agents?.defaults?.models ?? {};
  const restricted = cfg?.agents?.defaults?.restrictModels === true;
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) {
      continue;
    }
    const alias = String((entryRaw as { alias?: string } | undefined)?.alias ?? "").trim();
    if (!alias) {
      continue;
    }
    // Show where a family alias (`opus`, ...) resolves now, not a stale target.
    const slash = model.indexOf("/");
    const target =
      slash > 0 && !restricted
        ? resolveFamilyAliasTarget(alias, {
            provider: model.slice(0, slash),
            model: model.slice(slash + 1),
          })
        : undefined;
    entries.push({ alias, model: target ? `${target.provider}/${target.model}` : model });
  }
  return entries
    .toSorted((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}
