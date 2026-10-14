/**
 * Family shortcuts that follow the newest model (2026-10-14).
 *
 * A config alias named after a Claude family (`opus`, `sonnet`, `haiku`,
 * `fable`) that points at a model of that family resolves to the newest model
 * of the family the provider actually serves. Victor's `opus` pointed at
 * claude-opus-4-8 after Opus 5.5 shipped, so "switch to opus" picked an older
 * model and the agent's alias list said so. An alias with any other name
 * (`opus48`, `work`) is a pin and never moves.
 *
 * "Served" is the model catalog the gateway loads at startup (vendored
 * catalog + live /v1/models discovery, model-catalog.ts), recorded here
 * synchronously so alias resolution can stay sync. Before the catalog has
 * loaded (or in a CLI process that never loads it) aliases resolve exactly
 * as configured.
 */

const FAMILY_ALIASES: ReadonlySet<string> = new Set(["opus", "sonnet", "haiku", "fable"]);

/** `claude-<family>-<major>[-<minor>]`, e.g. claude-opus-5-5. Dated snapshots excluded. */
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/;

export function claudeFamilyVersion(id: string): { family: string; version: number } | undefined {
  const m = CLAUDE_ID.exec(id.trim().toLowerCase());
  if (!m) {
    return undefined;
  }
  return { family: m[1] ?? "", version: Number(m[2]) * 100 + Number(m[3] ?? 0) };
}

/** provider -> family -> newest served id. */
let newest = new Map<string, Map<string, { id: string; version: number }>>();

/** Record the models the provider serves (called when the catalog loads). */
export function recordServedModels(entries: ReadonlyArray<{ provider: string; id: string }>): void {
  const next = new Map<string, Map<string, { id: string; version: number }>>();
  for (const entry of entries) {
    const v = claudeFamilyVersion(entry.id);
    if (!v) {
      continue;
    }
    const provider = entry.provider.trim().toLowerCase();
    const families = next.get(provider) ?? new Map<string, { id: string; version: number }>();
    const best = families.get(v.family);
    if (!best || v.version > best.version) {
      families.set(v.family, { id: entry.id, version: v.version });
    }
    next.set(provider, families);
  }
  newest = next;
}

export function resetServedModelsForTest(): void {
  newest = new Map();
}

/**
 * The model a family alias resolves to: the newest served model of that
 * family when it is newer than the configured target, else the target.
 */
export function resolveFamilyAliasTarget<T extends { provider: string; model: string }>(
  alias: string,
  ref: T,
): T {
  const family = alias.trim().toLowerCase();
  if (!FAMILY_ALIASES.has(family)) {
    return ref;
  }
  const target = claudeFamilyVersion(ref.model);
  if (!target || target.family !== family) {
    return ref;
  }
  const best = newest.get(ref.provider.trim().toLowerCase())?.get(family);
  if (!best || best.version <= target.version) {
    return ref;
  }
  return { ...ref, model: best.id };
}

/** Newest served model id of a Claude family, if the catalog has been recorded. */
export function newestServedInFamily(provider: string, family: string): string | undefined {
  return newest.get(provider.trim().toLowerCase())?.get(family)?.id;
}

export type AliasFreshnessNote = {
  alias: string;
  configured: string;
  newest: string;
  follows: boolean;
};

/**
 * For doctor: aliases whose Claude target has a newer served model of the
 * same family. `follows` = a family alias that already resolves to it; else a
 * pin the user may want to update.
 */
export function aliasFreshnessNotes(
  models: Record<string, { alias?: string } | undefined>,
  opts: { restricted: boolean },
): AliasFreshnessNote[] {
  const notes: AliasFreshnessNote[] = [];
  for (const [ref, entry] of Object.entries(models)) {
    const alias = entry?.alias?.trim();
    const slash = ref.indexOf("/");
    if (!alias || slash <= 0) {
      continue;
    }
    const provider = ref.slice(0, slash);
    const v = claudeFamilyVersion(ref.slice(slash + 1));
    const best = v ? newest.get(provider.trim().toLowerCase())?.get(v.family) : undefined;
    if (!v || !best || best.version <= v.version) {
      continue;
    }
    notes.push({
      alias,
      configured: ref,
      newest: `${provider}/${best.id}`,
      follows:
        !opts.restricted &&
        FAMILY_ALIASES.has(alias.toLowerCase()) &&
        alias.toLowerCase() === v.family,
    });
  }
  return notes.toSorted((a, b) => a.alias.localeCompare(b.alias));
}
