/**
 * PLAN-45 Phase 6: the skill-evolution doctor section.
 *
 * Three things an operator cannot see from the config alone:
 *   1. Tasks-mode reachability: the promoting gate needs capability tasks;
 *      with none, the loop can only run the diagnostic judge and nothing
 *      is ever promoted.
 *   2. Monitor backlog: an active canary the monitor has not been able to
 *      look at (no exposure rows, past its maximum age) is a skill sitting
 *      in production with no verdict on the way.
 *   3. Crystallizer growth: migration v63 purged the auto-minted chunks;
 *      a non-zero count means the old minting path is back.
 * Plus the loop's heartbeat (last iteration vs cadence) and whether the
 * evidence records are being rebuilt. Every read is a plain file or a
 * read-only sqlite query; nothing here needs the gateway.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ImpactTrailOptions } from "../agents/skills/impact-trail.js";
import type { BitterbotConfig } from "../config/config.js";
import { readCanaryRegistry, isCanaryOff } from "../agents/skills/canary-registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import { readCanaryRuns } from "../memory/skill-evolution/canary-ledger.js";
import { CANARY_MAX_DAYS, MONITOR_CHECKPOINTS } from "../memory/skill-evolution/canary-stats.js";
import { loadEffectiveCorpus } from "../memory/skill-evolution/canonical-corpus.js";
import { readEvidenceRecords } from "../memory/skill-evolution/evidence-record.js";
import { readRecentIterations } from "../memory/skill-evolution/iteration-log.js";
import {
  countCapabilityTasks,
  resolveEffectiveValidationMode,
} from "../memory/skill-evolution/validation-mode.js";
import { renderSection, type CheckResult, ok, warn, info } from "./doctor-check.js";

const SECTION = "Skill Evolution";
/** An active canary with no exposure rows after this long is not being observed. */
export const CANARY_SILENT_MS = 3 * 86_400_000;
/** Evidence records older than this were not rebuilt by housekeeping. */
export const EVIDENCE_STALE_MS = 2 * 86_400_000;

export async function collectSkillEvolutionChecks(params: {
  config: BitterbotConfig;
  dbPath?: string;
  now?: number;
  trailOpts?: ImpactTrailOptions;
}): Promise<CheckResult[]> {
  const { config } = params;
  const now = params.now ?? Date.now();
  const trailOpts = params.trailOpts ?? {};
  const results: CheckResult[] = [];
  const evo = config.skills?.evolution ?? {};

  if (evo.enabled === false) {
    results.push(info("Skill evolution: disabled (skills.evolution.enabled=false)"));
    return results;
  }

  // ── 1. Tasks-mode reachability ──
  let capabilityTasks = 0;
  try {
    capabilityTasks = countCapabilityTasks(await loadEffectiveCorpus(trailOpts));
  } catch {
    capabilityTasks = 0;
  }
  const effective = resolveEffectiveValidationMode(evo.validationMode, capabilityTasks);
  if (effective.mode === "tasks") {
    results.push(
      ok(
        `Validation gate: tasks mode (${capabilityTasks} capability task${capabilityTasks === 1 ? "" : "s"}, ${effective.source})`,
      ),
    );
  } else {
    results.push(
      warn(
        [
          `Validation gate: ${effective.mode} mode (${effective.source}); nothing can be promoted.`,
          capabilityTasks === 0
            ? "  The tasks gate needs capability tasks. Review mined drafts:"
            : "  Capability tasks exist but the mode is not tasks. Switch:",
          `  ${formatCliCommand(capabilityTasks === 0 ? "bitterbot skills corpus list" : "bitterbot config set skills.evolution.validationMode tasks")}`,
        ].join("\n"),
      ),
    );
  }

  // ── 2. Loop heartbeat ──
  const cadenceMs = (evo.cadenceHours ?? 24) * 3_600_000;
  let iterations: Awaited<ReturnType<typeof readRecentIterations>> = [];
  try {
    iterations = await readRecentIterations(5, trailOpts);
  } catch {
    iterations = [];
  }
  const last = iterations[iterations.length - 1];
  if (!last) {
    results.push(
      info("Evolution loop: no iteration recorded yet (runs from housekeeping on the cadence)"),
    );
  } else if (now - last.at > 2 * cadenceMs) {
    results.push(
      warn(
        `Evolution loop: last iteration ${Math.round((now - last.at) / 3_600_000)}h ago, cadence ${evo.cadenceHours ?? 24}h; housekeeping is not reaching it`,
      ),
    );
  } else {
    const skipped = iterations.filter((i) => !i.ran).length;
    results.push(
      ok(
        `Evolution loop: last iteration ${Math.round((now - last.at) / 3_600_000)}h ago${skipped === iterations.length && iterations.length > 1 ? ` (last ${iterations.length} skipped: ${last.reason ?? "no reason"})` : ""}`,
      ),
    );
  }

  // ── 3. Monitor backlog ──
  let registry: Awaited<ReturnType<typeof readCanaryRegistry>>;
  try {
    registry = await readCanaryRegistry(trailOpts);
  } catch {
    registry = { version: 1, skills: {} };
  }
  const active = Object.entries(registry.skills).filter(([, e]) => !isCanaryOff(e));
  if (active.length === 0) {
    results.push(info("Canary monitor: no active canary"));
  } else {
    let rows: Awaited<ReturnType<typeof readCanaryRuns>> = [];
    try {
      rows = await readCanaryRuns(trailOpts);
    } catch {
      rows = [];
    }
    for (const [name, entry] of active) {
      const mine = rows.filter((r) => r.skill === name && r.ts >= entry.startedAt && r.credited);
      const exposed = mine.filter((r) => r.exposed).length;
      const unexposed = mine.length - exposed;
      const ageDays = (now - entry.startedAt) / 86_400_000;
      const nextLook =
        (entry.strict?.checkpoints ?? MONITOR_CHECKPOINTS).find((c) => c > exposed) ?? null;
      const summary = `${name}: ${exposed} exposed / ${unexposed} control credited runs, ${ageDays.toFixed(1)}d old, next look at ${nextLook ?? "done"}`;
      if (ageDays > CANARY_MAX_DAYS) {
        results.push(
          warn(
            `Canary past its ${CANARY_MAX_DAYS}-day maximum with no verdict: ${summary}\n  The monitor runs from housekeeping; if housekeeping is running, inspect: ${formatCliCommand(`bitterbot skills evidence ${name}`)}`,
          ),
        );
      } else if (mine.length === 0 && now - entry.startedAt > CANARY_SILENT_MS) {
        results.push(
          warn(
            `Canary with no exposure rows after ${ageDays.toFixed(1)} days: ${name} (${entry.reason})\n  Either no run has carried the skill in its index or the exposure filter is not running.`,
          ),
        );
      } else {
        results.push(ok(`Canary monitor: ${summary}`));
      }
    }
  }

  // ── 4. Evidence records ──
  let records: Awaited<ReturnType<typeof readEvidenceRecords>> = [];
  try {
    records = await readEvidenceRecords(trailOpts);
  } catch {
    records = [];
  }
  const managed = records.filter((r) => r.ladder !== "unmanaged");
  const stale = records.filter((r) => now - r.generatedAt > EVIDENCE_STALE_MS);
  if (records.length === 0) {
    results.push(
      info("Evidence records: none yet (housekeeping writes .evidence.json per live skill)"),
    );
  } else if (stale.length === records.length) {
    results.push(
      warn(
        `Evidence records: all ${records.length} older than ${EVIDENCE_STALE_MS / 86_400_000} days; housekeeping is not rebuilding them`,
      ),
    );
  } else {
    const ladders = managed.reduce<Record<string, number>>((acc, r) => {
      acc[r.ladder] = (acc[r.ladder] ?? 0) + 1;
      return acc;
    }, {});
    const ladderText = Object.entries(ladders)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    results.push(
      ok(
        `Evidence records: ${records.length} live skills, ${managed.length} managed${ladderText ? ` (${ladderText})` : ""}`,
      ),
    );
  }

  // ── 5. Crystallizer growth ──
  if (params.dbPath && fs.existsSync(params.dbPath)) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(params.dbPath, { open: true, readOnly: true });
      const has = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'")
        .get();
      if (has) {
        const row = db
          .prepare(
            "SELECT COUNT(*) AS n FROM chunks WHERE path = 'crystallizer/auto' AND source = 'skills'",
          )
          .get() as { n: number } | undefined;
        const n = row?.n ?? 0;
        results.push(
          n === 0
            ? ok("Crystallizer: 0 auto-minted chunks (purged by migration v63, none since)")
            : warn(
                `Crystallizer: ${n} auto-minted chunks present; the retired minting path is writing again (PLAN-45 Phase 0 invariant I7)`,
              ),
        );
      }
    } catch (err) {
      results.push(info(`Crystallizer: could not read the memory database (${String(err)})`));
    } finally {
      db?.close();
    }
  }

  return results;
}

export async function runSkillEvolutionChecks(params: {
  config: BitterbotConfig;
  dbPath?: string;
}): Promise<void> {
  renderSection(SECTION, await collectSkillEvolutionChecks(params));
}
