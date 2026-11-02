/**
 * Run-path adapter for the experience-guided skill prior (skill-prior.ts is
 * pure; this file owns the I/O): load the ledger from disk once per mtime,
 * hash the skills in the index by content, reorder, and journal the
 * decision on the `skills` stream next to the canary exposure row.
 *
 * Default off (`skills.prior.enabled`). Nothing here writes the ledger.
 */

import { createHash } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR } from "../../utils.js";
import type { Skill } from "./skill-loader.js";
import {
  applySkillPrior,
  resolveSkillPriorMode,
  resolveSkillPriorPlacement,
  SKILL_PRIOR_DEFAULTS,
  SkillPriorLedger,
} from "./skill-prior.js";

const log = createSubsystemLogger("skills/prior");

/** Context cell used on the live path until a verified live outcome signal exists. */
export const DEFAULT_PRIOR_CELL = "default";

export function skillPriorLedgerPath(cfg: BitterbotConfig | undefined): string {
  return cfg?.skills?.prior?.ledgerPath ?? path.join(CONFIG_DIR, "skill-prior.json");
}

let ledgerCache: { path: string; mtimeMs: number; ledger: SkillPriorLedger } | null = null;

/** The on-disk ledger, re-read only when its mtime changes; empty when absent or malformed. */
export function loadSkillPriorLedger(cfg: BitterbotConfig | undefined): SkillPriorLedger {
  const file = skillPriorLedgerPath(cfg);
  const opts = {
    discount: cfg?.skills?.prior?.discount ?? SKILL_PRIOR_DEFAULTS.discount,
    pseudoCount: cfg?.skills?.prior?.pseudoCount ?? SKILL_PRIOR_DEFAULTS.pseudoCount,
  };
  let mtimeMs = -1;
  try {
    mtimeMs = fsSync.statSync(file).mtimeMs;
  } catch {
    return new SkillPriorLedger(undefined, opts);
  }
  if (ledgerCache && ledgerCache.path === file && ledgerCache.mtimeMs === mtimeMs) {
    return ledgerCache.ledger;
  }
  try {
    const ledger = SkillPriorLedger.fromJSON(fsSync.readFileSync(file, "utf-8"), opts);
    ledgerCache = { path: file, mtimeMs, ledger };
    return ledger;
  } catch (err) {
    log.warn(`skill prior ledger unreadable at ${file}: ${String(err)}; using an empty ledger`);
    return new SkillPriorLedger(undefined, opts);
  }
}

const hashCache = new Map<string, { mtimeMs: number; hash: string }>();

/** sha256 of a skill file's content, cached by mtime. "unknown" when unreadable. */
export function skillContentHash(filePath: string): string {
  try {
    const st = fsSync.statSync(filePath);
    const hit = hashCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs) {
      return hit.hash;
    }
    const hash = createHash("sha256").update(fsSync.readFileSync(filePath)).digest("hex");
    hashCache.set(filePath, { mtimeMs: st.mtimeMs, hash });
    if (hashCache.size > 2_000) {
      hashCache.delete(hashCache.keys().next().value as string);
    }
    return hash;
  } catch {
    return "unknown";
  }
}

export function skillHashes(
  skills: readonly Pick<Skill, "name" | "filePath">[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const skill of skills) {
    out[skill.name] = skillContentHash(skill.filePath);
  }
  return out;
}

export function applySkillPriorForRun(params: {
  prompt: string;
  config: BitterbotConfig | undefined;
  runId: string;
  sessionKey?: string;
  skills: readonly Pick<Skill, "name" | "filePath">[];
  bypass?: boolean;
  cell?: string;
}): string {
  const mode = resolveSkillPriorMode(params.config?.skills?.prior);
  if (mode === "off" || params.bypass || !params.prompt) {
    return params.prompt;
  }
  try {
    const ledger = loadSkillPriorLedger(params.config);
    const cell = params.cell ?? DEFAULT_PRIOR_CELL;
    const applied = applySkillPrior({
      prompt: params.prompt,
      cell,
      ledger,
      hashes: skillHashes(params.skills),
      mode,
      placement: resolveSkillPriorPlacement(params.config?.skills?.prior),
    });
    emitAgentEvent({
      runId: params.runId,
      stream: "skills",
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      data: {
        prior: {
          cell,
          mode,
          changed: applied.changed,
          baseline: applied.baseline,
          order: applied.order,
          means: applied.result?.means ?? {},
        },
      },
    });
    return applied.prompt;
  } catch (err) {
    log.warn(`skill prior skipped for run ${params.runId}: ${String(err)}`);
    return params.prompt;
  }
}

export function resetSkillPriorCachesForTest(): void {
  ledgerCache = null;
  hashCache.clear();
}
