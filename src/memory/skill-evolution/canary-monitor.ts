/**
 * PLAN-45 Phase 3.3/3.5/3.6: the post-promotion monitor.
 *
 * The gate proves a candidate on held-out tasks; production is the real
 * test. Every promoted skill lives a canary window (canary-registry.ts:
 * shown to half the eligible runs, withheld from the rest). Each
 * housekeeping pass this module reads the canary-runs ledger and decides
 * per canary (canary-stats.ts): roll back when the exposed-and-read cohort
 * passes significantly less often than the withheld cohort, retire when
 * the router never opens it, graduate to `stable` when the window closes
 * without a regression. A `stable` skill whose primary model changed goes
 * back to canary (3.5). When a staged CREATE is held at the evolved-skill
 * cap, the weakest evidence retires to free the slot (3.6, D-5).
 *
 * Every transition is one primitive (`demoteEvolved`, canary-demote.ts):
 * archive first, change live second, record in the impact trail, bump the
 * snapshot, and retract on the mesh when the version was published.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SkillLifecycleStore } from "../skill-lifecycle.js";
import type { SkillPublisher } from "./p2p-publish.js";
import {
  DEFAULT_CANARY_FRACTION,
  readCanaryRegistry,
  registerCanary,
  unregisterCanary,
} from "../../agents/skills/canary-registry.js";
import { appendImpactEntry, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import {
  readLive,
  resolveStorageRoots,
  type StorageRoots,
} from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  demoteEvolved,
  listLiveEvolvedMeta,
  readLiveEvolvedMeta,
  rollbackFreesSlot,
  writeLiveEvolvedMeta,
} from "./canary-demote.js";
import { type CanaryRunRow, readCanaryRuns } from "./canary-ledger.js";
import { type CanaryDecision, type Cohort, decideCanary } from "./canary-stats.js";
import { readEvidenceRecords, type SkillEvidenceRecord } from "./evidence-record.js";
import {
  DEFAULT_MAX_ACTIVE_EVOLVED,
  type EvolutionMeta,
  listStagedEvolutionProposals,
  skillDescription,
} from "./validation-gate.js";

const log = createSubsystemLogger("skill-evolution/canary-monitor");

/** A skill must have been live this long before the cap can retire it (D-5 grace). */
export const CAP_RETIRE_GRACE_DAYS = 7;

export interface CanaryMonitorAction {
  skillName: string;
  action: "continue" | "graduated" | "rolled-back" | "retired" | "re-canaried" | "stale" | "error";
  detail: string;
}

export interface CanaryMonitorResult {
  monitored: number;
  actions: CanaryMonitorAction[];
}

export interface CanaryMonitorDeps {
  storeOpts?: ImpactTrailOptions;
  lifecycleStore?: SkillLifecycleStore | null;
  publisher?: SkillPublisher | null;
  /** The agent's primary model (`provider/model`); drives 3.5 re-canary. Null = unknown, no-op. */
  runtimeModelTag?: string | null;
  maxActiveEvolved?: number;
  iteration?: string;
  now?: number;
}

/**
 * The monitor's cohorts for one canary over its window. Pure.
 * Intention-to-treat (adversarial 3-2): exposure, not the agent's choice
 * to open the skill, selects the cohort; eligibility is the lexical proxy
 * on both sides. A withheld run that still read the skill (the text was in
 * its session transcript from an earlier exposed turn; adversarial 3-3) is
 * contaminated control and counts as exposed.
 */
export function buildCanaryWindow(
  rows: CanaryRunRow[],
  skill: string,
  startedAt: number,
): {
  exposedEligible: number;
  exposed: Cohort;
  unexposed: Cohort;
  reads: number;
} {
  const exposedEligibleRuns = new Set<string>();
  const exposed: Cohort = { n: 0, pass: 0 };
  const unexposed: Cohort = { n: 0, pass: 0 };
  let reads = 0;
  for (const r of rows) {
    if (r.skill !== skill || r.ts < startedAt || !r.credited) {
      continue;
    }
    const determinate = r.label === "pass" || r.label === "fail";
    const treated = r.exposed || r.read;
    if (r.read) {
      reads += 1;
    }
    if (!r.eligible) {
      continue;
    }
    if (treated) {
      exposedEligibleRuns.add(r.runId);
      if (determinate) {
        exposed.n += 1;
        exposed.pass += r.label === "pass" ? 1 : 0;
      }
    } else if (determinate) {
      unexposed.n += 1;
      unexposed.pass += r.label === "pass" ? 1 : 0;
    }
  }
  return { exposedEligible: exposedEligibleRuns.size, exposed, unexposed, reads };
}

function decisionStats(
  d: CanaryDecision,
  w: ReturnType<typeof buildCanaryWindow>,
): Record<string, number | null> {
  return {
    exposedEligible: w.exposedEligible,
    exposedN: w.exposed.n,
    exposedPass: w.exposed.pass,
    unexposedN: w.unexposed.n,
    unexposedPass: w.unexposed.pass,
    reads: w.reads,
    pValue: d.action === "rollback" ? d.pValue : null,
    gap: d.action === "rollback" ? d.gap : null,
  };
}

/** One monitor pass over every registered canary, then the model-drift check. */
export async function runCanaryMonitor(deps: CanaryMonitorDeps = {}): Promise<CanaryMonitorResult> {
  const opts = deps.storeOpts ?? {};
  const trailOpts = opts.configDir ? { configDir: opts.configDir } : {};
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  const now = deps.now ?? Date.now();
  const registry = await readCanaryRegistry(trailOpts);
  const names = Object.keys(registry.skills).toSorted();
  const actions: CanaryMonitorAction[] = [];
  const rows = names.length > 0 ? await readCanaryRuns(trailOpts) : [];

  for (const name of names) {
    const entry = registry.skills[name];
    if (!entry) {
      continue;
    }
    try {
      const meta = await readLiveEvolvedMeta(roots, name);
      if (!meta || meta.ladder?.state !== "canary" || !(await readLive(roots, name))) {
        await unregisterCanary(name, trailOpts);
        actions.push({
          skillName: name,
          action: "stale",
          detail: "registry entry without a live canary meta; removed",
        });
        continue;
      }
      const window = buildCanaryWindow(rows, name, entry.startedAt);
      const decision = decideCanary({
        startedAt: entry.startedAt,
        now,
        ...window,
        checkpointsDone: meta.canary?.checkpoints ?? [],
      });
      const stats = decisionStats(decision, window);
      if (decision.action === "rollback") {
        const r = await demoteEvolved({
          name,
          meta,
          kind: "rollback",
          reason: `production regression: ${decision.reason}`,
          by: "monitor",
          stats,
          storeOpts: trailOpts,
          lifecycleStore: deps.lifecycleStore ?? null,
          publisher: deps.publisher ?? null,
          ...(deps.iteration ? { iteration: deps.iteration } : {}),
          now,
        });
        actions.push({ skillName: name, action: r.action, detail: r.detail });
      } else if (decision.action === "retire") {
        // Adversarial 3-1: a PATCH that never fires gives the previous
        // version back; only a create is removed.
        const r = await demoteEvolved({
          name,
          meta,
          kind: typeof meta.promotedFrom === "number" ? "rollback" : "retire",
          reason: decision.reason,
          by: "monitor",
          stats,
          storeOpts: trailOpts,
          lifecycleStore: deps.lifecycleStore ?? null,
          publisher: deps.publisher ?? null,
          ...(deps.iteration ? { iteration: deps.iteration } : {}),
          now,
        });
        actions.push({ skillName: name, action: r.action, detail: r.detail });
      } else if (decision.action === "graduate") {
        await writeLiveEvolvedMeta(roots, name, {
          ...meta,
          ladder: {
            state: "stable",
            at: now,
            by: "monitor",
            reason: decision.reason,
            previous: "canary",
          },
          canary: meta.canary ? { ...meta.canary, endedAt: now } : undefined,
        });
        await unregisterCanary(name, trailOpts);
        await appendImpactEntry(
          {
            source: "evolution",
            action: "graduate",
            skillName: name,
            verdict: "accepted",
            detail: `canary -> stable: ${decision.reason}`,
            stats,
            ...(deps.iteration ? { iteration: deps.iteration } : {}),
            ...(meta.validation?.model ? { model: meta.validation.model } : {}),
            timestamp: now,
          },
          trailOpts,
        );
        actions.push({ skillName: name, action: "graduated", detail: decision.reason });
        log.info(`canary graduated ${name}: ${decision.reason}`);
      } else {
        if (decision.checkpoint !== undefined && meta.canary) {
          // Persist the look so the next pass does not test the same size again.
          await writeLiveEvolvedMeta(roots, name, {
            ...meta,
            canary: {
              ...meta.canary,
              checkpoints: [...(meta.canary.checkpoints ?? []), decision.checkpoint],
            },
          });
        }
        actions.push({ skillName: name, action: "continue", detail: decision.reason });
      }
    } catch (err) {
      actions.push({ skillName: name, action: "error", detail: String(err) });
      log.warn(`canary monitor failed for ${name}: ${String(err)}`);
    }
  }

  // 3.5: a stable skill validated under another primary model is unproven
  // again. Trigger on the configured tag only (a failover retry changes a
  // run's model; the config does not flap), once per target model.
  const current = deps.runtimeModelTag?.trim();
  if (current) {
    for (const { name, meta } of await listLiveEvolvedMeta(roots)) {
      const from = meta.validation?.model;
      if (meta.ladder?.state !== "stable" || !from || from === current) {
        continue;
      }
      if (meta.modelDrift?.to === current) {
        continue;
      }
      try {
        const description = skillDescription((await readLive(roots, name)) ?? "") ?? "";
        await writeLiveEvolvedMeta(roots, name, {
          ...meta,
          ladder: {
            state: "canary",
            at: now,
            by: "model-drift",
            reason: `primary model ${from} -> ${current}`,
            previous: "stable",
          },
          canary: {
            startedAt: now,
            bucketFraction: DEFAULT_CANARY_FRACTION,
            reason: "model-drift",
          },
          modelDrift: { from, to: current, at: now },
        });
        await registerCanary(
          name,
          {
            startedAt: now,
            bucketFraction: DEFAULT_CANARY_FRACTION,
            descriptionAtStart: description,
            reason: "model-drift",
          },
          trailOpts,
        );
        await appendImpactEntry(
          {
            source: "evolution",
            action: "re-canary",
            skillName: name,
            verdict: "canary",
            detail: `stable -> canary: primary model ${from} -> ${current}`,
            ...(deps.iteration ? { iteration: deps.iteration } : {}),
            model: current,
            timestamp: now,
          },
          trailOpts,
        );
        actions.push({
          skillName: name,
          action: "re-canaried",
          detail: `primary model ${from} -> ${current}`,
        });
        log.info(`re-canaried ${name}: primary model ${from} -> ${current}`);
      } catch (err) {
        actions.push({ skillName: name, action: "error", detail: String(err) });
      }
    }
  }
  return { monitored: names.length, actions };
}

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
    ({ meta }) => meta.ladder?.state !== "rolled-back" && meta.ladder?.state !== "retired",
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
