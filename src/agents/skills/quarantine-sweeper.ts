/**
 * PLAN-13 Phase C: quarantine TTL sweeper.
 *
 * Skills sitting in `skills-incoming/` accumulate forever today. Operators
 * who don't proactively review quarantine accumulate a long tail of
 * stale-but-not-expired envelopes, which tempts them to flip policy to
 * `auto` for ergonomics — collapsing the defense-in-depth back to the
 * trust list.
 *
 * The sweep is conservative: only auto-rejects entries whose ingestion
 * timestamp is older than `skills.p2p.quarantineTtlDays` (default 30).
 * The decision is "reject, not delete" — `rejectIncomingSkill` removes
 * the skill from quarantine; the operator-facing notification lets them
 * know what happened.
 *
 * Pure function design: takes a config, returns a report. Production
 * scheduling lives at the call site (consolidation tick at
 * `src/memory/manager.ts:1316`).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR } from "../../utils.js";
import { rejectIncomingSkill } from "./ingest.js";

const log = createSubsystemLogger("skills/quarantine-sweeper");

const DEFAULT_TTL_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export type QuarantineSweepReport = {
  scanned: number;
  expired: string[];
  errored: Array<{ name: string; reason: string }>;
};

/**
 * Walk the quarantine directory and reject any skill whose ingestion
 * timestamp is older than the configured TTL.
 *
 * Returns a structured report. `expired` lists the skill names that were
 * rejected (one per `rejectIncomingSkill` call). `errored` lists any
 * envelopes the sweeper could not parse — these are left in place so an
 * operator can decide manually.
 */
export async function sweepQuarantine(opts: {
  config: BitterbotConfig | undefined;
  /** Optional sink for "auto-rejected" notifications. */
  notify?: (message: string) => void;
  /** Override "now" for tests. */
  now?: number;
}): Promise<QuarantineSweepReport> {
  const ttlDays = opts.config?.skills?.p2p?.quarantineTtlDays ?? DEFAULT_TTL_DAYS;
  const ttlMs = ttlDays * MS_PER_DAY;
  const now = opts.now ?? Date.now();
  const cutoff = now - ttlMs;

  const quarantineDir =
    opts.config?.skills?.p2p?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");

  const report: QuarantineSweepReport = { scanned: 0, expired: [], errored: [] };

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(quarantineDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      // No quarantine directory yet — nothing to sweep, not an error.
      return report;
    }
    log.debug(`sweep failed to read quarantine dir: ${String(err)}`);
    return report;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    report.scanned++;
    const skillName = entry.name;
    const envelopePath = path.join(quarantineDir, skillName, ".envelope.json");

    let ingestedAt: number | undefined;
    try {
      const raw = await fs.readFile(envelopePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Prefer the envelope's `timestamp` (publish time on the wire);
      // fall back to file mtime if not present.
      if (typeof parsed.timestamp === "number") {
        ingestedAt = parsed.timestamp;
      }
    } catch {
      // Fall through — try mtime.
    }

    if (ingestedAt === undefined) {
      // No envelope or no usable timestamp inside it. Fall back to the
      // mtime of any file we can find inside the quarantine entry — the
      // SKILL.md is always written, the envelope sometimes isn't.
      const fallbackCandidates = [envelopePath, path.join(quarantineDir, skillName, "SKILL.md")];
      for (const candidate of fallbackCandidates) {
        try {
          const stat = await fs.stat(candidate);
          ingestedAt = stat.mtimeMs;
          break;
        } catch {
          // try the next candidate
        }
      }
      if (ingestedAt === undefined) {
        report.errored.push({
          name: skillName,
          reason: "unable to determine age: no envelope and no SKILL.md mtime",
        });
        continue;
      }
    }

    if (ingestedAt > cutoff) {
      // Still within TTL.
      continue;
    }

    const ageDays = Math.floor((now - ingestedAt) / MS_PER_DAY);
    try {
      const result = await rejectIncomingSkill({
        skillName,
        config: opts.config ?? {},
      });
      if (result.ok) {
        report.expired.push(skillName);
        log.info(`auto-rejected stale quarantine: ${skillName} (age=${ageDays}d)`);
        if (opts.notify) {
          try {
            opts.notify(
              `Quarantined skill "${skillName}" auto-rejected after ${ageDays}d (TTL=${ttlDays}d). Adjust skills.p2p.quarantineTtlDays to change.`,
            );
          } catch (err) {
            log.debug(`notify threw: ${String(err)}`);
          }
        }
      } else {
        report.errored.push({
          name: skillName,
          reason: result.reason ?? "rejection failed",
        });
      }
    } catch (err) {
      report.errored.push({ name: skillName, reason: String(err) });
    }
  }

  return report;
}
