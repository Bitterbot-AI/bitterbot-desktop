/**
 * PLAN-45 Phase 3.6 (D-5): retirement at the evolved-skill cap by evidence
 * score. Split out of canary-monitor.ts (500-line cap).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { CanaryMonitorAction, CanaryMonitorDeps } from "./canary-monitor.js";
import {
  readLive,
  resolveStorageRoots,
  type StorageRoots,
} from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { demoteEvolved, listLiveEvolvedMeta, rollbackFreesSlot } from "./canary-demote.js";
import { readEvidenceRecords, type SkillEvidenceRecord } from "./evidence-record.js";
import {
  DEFAULT_MAX_ACTIVE_EVOLVED,
  type EvolutionMeta,
  listStagedEvolutionProposals,
} from "./validation-gate.js";

const log = createSubsystemLogger("skill-evolution/canary-cap");

/** A skill must have been live this long before the cap can retire it (D-5 grace). */
export const CAP_RETIRE_GRACE_DAYS = 7;

async function readStagedEvolutionMeta(
  roots: StorageRoots,
  name: string,
): Promise<EvolutionMeta | null> {
  try {
    const raw = await fs.readFile(
      path.join(roots.stagingRoot, name, ".evolution-meta.json"),
      "utf-8",
    );
    return JSON.parse(raw) as EvolutionMeta;
  } catch {
    return null;
  }
}

/** reads(14d) x Laplace pass rate; zero-read skills score 0. */
export function evidenceScore(record: SkillEvidenceRecord | undefined): number {
  if (!record) {
    return 0;
  }
  const { total, pass, fail } = record.reads;
  return total * ((pass + 1) / (pass + fail + 2));
}

/**
 * 3.6 (D-5): when a staged CREATE would be held at the evolved-skill cap,
 * retire the weakest live evidence to free the slot: first any skill with
 * zero reads in the window (oldest first), else the lowest evidence score.
 * Age is grace and tiebreak only. One slot per held create per pass.
 */
export async function retireEvolvedAtCap(
  deps: CanaryMonitorDeps = {},
): Promise<CanaryMonitorAction[]> {
  const opts = deps.storeOpts ?? {};
  const trailOpts = opts.configDir ? { configDir: opts.configDir } : {};
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  const now = deps.now ?? Date.now();
  const cap = deps.maxActiveEvolved ?? DEFAULT_MAX_ACTIVE_EVOLVED;
  const staged = await listStagedEvolutionProposals(roots);
  const creates: string[] = [];
  for (const name of staged) {
    if (await readLive(roots, name)) {
      continue;
    }
    // Adversarial 3-6: a create the gate will hold as untrusted-evidence-only
    // must not cost a live slot.
    const stagedMeta = await readStagedEvolutionMeta(roots, name);
    if (
      stagedMeta?.evidence &&
      !stagedMeta.evidence.origins.some((o) => o === "human" || o === "system")
    ) {
      continue;
    }
    creates.push(name);
  }
  if (creates.length === 0) {
    return [];
  }
  const live = (await listLiveEvolvedMeta(roots)).filter(
    ({ meta }) =>
      meta.origin === "wiki-evolution" &&
      meta.ladder?.state !== "rolled-back" &&
      meta.ladder?.state !== "retired",
  );
  const needed = Math.min(creates.length, live.length + creates.length - cap);
  if (needed <= 0) {
    return [];
  }
  const records = new Map((await readEvidenceRecords(trailOpts)).map((r) => [r.name, r]));
  const graceMs = CAP_RETIRE_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const candidates = live
    .filter(({ meta }) => {
      const state = meta.ladder?.state;
      const validatedAt = meta.validation?.validatedAt;
      // Adversarial 3-6: a canary is withheld from half its runs, so by
      // construction it looks like the weakest evidence; only a stable (or
      // pre-Phase-3, un-laddered) skill competes for its slot.
      return (
        (state === "stable" || state === undefined) &&
        typeof validatedAt === "number" &&
        now - validatedAt >= graceMs
      );
    })
    .map(({ name, meta }) => {
      const record = records.get(name);
      return {
        name,
        meta,
        score: evidenceScore(record),
        reads: record?.reads.total ?? 0,
        lastReadAt: record?.reads.lastReadAt ?? null,
        validatedAt: meta.validation?.validatedAt ?? 0,
        wins: meta.validation?.wins ?? 0,
      };
    })
    .toSorted((a, b) => {
      if ((a.reads === 0) !== (b.reads === 0)) {
        return a.reads === 0 ? -1 : 1;
      }
      if (a.reads === 0 && b.reads === 0) {
        return (a.lastReadAt ?? a.validatedAt) - (b.lastReadAt ?? b.validatedAt);
      }
      if (a.score !== b.score) {
        return a.score - b.score;
      }
      if (a.validatedAt !== b.validatedAt) {
        return a.validatedAt - b.validatedAt;
      }
      return a.wins - b.wins;
    });
  const actions: CanaryMonitorAction[] = [];
  for (const c of candidates.slice(0, needed)) {
    try {
      // A patch whose previous version had no evolution identity frees the
      // slot by rolling back (the human/harvested version comes back).
      const freesByRollback = await rollbackFreesSlot(roots, c.name, c.meta);
      const r = await demoteEvolved({
        name: c.name,
        meta: c.meta,
        kind: freesByRollback === true ? "rollback" : "retire",
        reason: `evolved-skill cap (${cap}) reached with ${creates.length} staged create(s); weakest evidence (${c.reads} reads in window, score ${c.score.toFixed(2)})`,
        by: "cap",
        stats: { reads: c.reads, score: c.score },
        storeOpts: trailOpts,
        lifecycleStore: deps.lifecycleStore ?? null,
        publisher: deps.publisher ?? null,
        ...(deps.iteration ? { iteration: deps.iteration } : {}),
        now,
      });
      actions.push({ skillName: c.name, action: r.action, detail: r.detail });
    } catch (err) {
      actions.push({ skillName: c.name, action: "error", detail: String(err) });
      log.warn(`cap retirement failed for ${c.name}: ${String(err)}`);
    }
  }
  if (actions.length > 0) {
    log.info(
      `cap retirement: freed ${actions.filter((a) => a.action !== "error").length}/${needed} slot(s) for ${creates.join(", ")}`,
    );
  }
  return actions;
}

export { demoteEvolved, listLiveEvolvedMeta } from "./canary-demote.js";
