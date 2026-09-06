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

import type { SkillLifecycleStore } from "../skill-lifecycle.js";
import type { SkillPublisher } from "./p2p-publish.js";
import {
  canaryOff,
  DEFAULT_CANARY_FRACTION,
  isCanaryOff,
  readCanaryRegistry,
  registerCanary,
  unregisterCanary,
} from "../../agents/skills/canary-registry.js";
import { appendImpactEntry, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { readLive, resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  demoteEvolved,
  listLiveEvolvedMeta,
  readLiveEvolvedMeta,
  writeLiveEvolvedMeta,
} from "./canary-demote.js";
import { type CanaryRunRow, readCanaryRuns } from "./canary-ledger.js";
import { type CanaryDecision, type Cohort, decideCanary } from "./canary-stats.js";
import { skillDescription } from "./validation-gate.js";

const log = createSubsystemLogger("skill-evolution/canary-monitor");

export interface CanaryMonitorAction {
  skillName: string;
  action:
    | "continue"
    | "graduated"
    | "rolled-back"
    | "retired"
    | "re-canaried"
    | "canary-off"
    | "stale"
    | "error";
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
      // PLAN-45 4.3: a canary-off entry is a standing demotion, not a
      // window; it is never measured, graduated or swept as stale.
      if (isCanaryOff(entry)) {
        if (!(await readLive(roots, name))) {
          await unregisterCanary(name, trailOpts);
          actions.push({
            skillName: name,
            action: "stale",
            detail: "canary-off entry without a live skill; removed",
          });
        } else {
          actions.push({
            skillName: name,
            action: "continue",
            detail: `canary-off (${entry.reason})`,
          });
        }
        continue;
      }
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
      const decision = decideCanary(
        {
          startedAt: entry.startedAt,
          now,
          ...window,
          checkpointsDone: meta.canary?.checkpoints ?? [],
        },
        entry.strict ?? {},
      );
      const stats = decisionStats(decision, window);
      if (
        meta.origin === "peer" &&
        (decision.action === "rollback" || decision.action === "retire")
      ) {
        // PLAN-45 4.2/4.3 (D-4): a peer skill is never deleted by the
        // monitor; a regression or a dead description withholds it from
        // every run with the files kept.
        await writeLiveEvolvedMeta(roots, name, {
          ...meta,
          ladder: {
            state: "canary-off",
            at: now,
            by: "monitor",
            reason: decision.reason,
            previous: "canary",
          },
          canary: meta.canary ? { ...meta.canary, endedAt: now } : undefined,
        });
        await canaryOff(
          name,
          {
            reason: decision.action === "rollback" ? "regression" : "never-read",
            descriptionAtStart: entry.descriptionAtStart,
            now,
          },
          trailOpts,
        );
        await appendImpactEntry(
          {
            source: "evolution",
            action: "canary-off",
            skillName: name,
            verdict: "rolled-back",
            detail: `peer skill withheld from every run: ${decision.reason}`,
            stats,
            ...(deps.iteration ? { iteration: deps.iteration } : {}),
            timestamp: now,
          },
          trailOpts,
        );
        actions.push({ skillName: name, action: "canary-off", detail: decision.reason });
        log.info(`canary-off ${name}: ${decision.reason}`);
        continue;
      }
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
      // Adversarial 4-5: a standing demotion is never overwritten by a window.
      if (isCanaryOff(registry.skills[name])) {
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

export { CAP_RETIRE_GRACE_DAYS, evidenceScore, retireEvolvedAtCap } from "./canary-cap.js";
