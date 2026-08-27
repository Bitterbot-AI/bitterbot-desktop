/**
 * PLAN-41 Phase 2 (sota-bar rec 1): structured doctor findings for the
 * Control UI's Repairs card. Reuses the REAL doctor check functions — the
 * fast, purely-local subset (no model calls, no network probes, no gateway
 * self-connection) — through the same JSON collector `doctor --json` uses,
 * so the card and the CLI can never disagree about what a finding says.
 *
 * The collector is module-global, so runs are single-flighted and cached
 * briefly; the gateway never runs the CLI doctor concurrently in-process.
 */
import { loadConfig } from "../config/config.js";
import { noteBootHealth } from "./doctor-boot-health.js";
import { setDoctorJsonMode } from "./doctor-check.js";
import { runControlUiChecks } from "./doctor-control-ui.js";
import { runIdentityChecks } from "./doctor-identity.js";
import {
  doctorFindings,
  resetDoctorOutcome,
  worstFindingLevel,
  type DoctorFinding,
  type DoctorLevel,
} from "./doctor-outcome.js";
import { runSecurityChecks } from "./doctor-security.js";

export type RepairFindingsReport = {
  findings: DoctorFinding[];
  worstLevel: DoctorLevel;
  checkedAt: number;
};

const CACHE_TTL_MS = 60_000;
let cached: RepairFindingsReport | null = null;
let inFlight: Promise<RepairFindingsReport> | null = null;

export async function collectRepairFindings(opts?: {
  now?: number;
  force?: boolean;
}): Promise<RepairFindingsReport> {
  const now = opts?.now ?? Date.now();
  if (!opts?.force && cached && now - cached.checkedAt < CACHE_TTL_MS) {
    return cached;
  }
  if (inFlight) {
    return inFlight;
  }
  inFlight = (async () => {
    setDoctorJsonMode(true);
    resetDoctorOutcome();
    try {
      const cfg = loadConfig();
      runIdentityChecks({ config: cfg });
      await runSecurityChecks(cfg);
      await runControlUiChecks(cfg);
      // Auto-rollback surfaced as a persistent card (sota-bar rec 2): the
      // boot watchdog's record is warn/error until the next clean update.
      noteBootHealth(now);
      // PLAN-41 D-F: memory-offline surfaced here (the Repairs card is the
      // banner). Building the index is cached on success; on failure the
      // provider error explains exactly which key/dependency is missing.
      await noteMemoryHealth(cfg);
      const report: RepairFindingsReport = {
        findings: [...doctorFindings()],
        worstLevel: worstFindingLevel(),
        checkedAt: now,
      };
      cached = report;
      return report;
    } finally {
      setDoctorJsonMode(false);
      resetDoctorOutcome();
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test hook. */
export function resetRepairFindingsCache(): void {
  cached = null;
  inFlight = null;
}

async function noteMemoryHealth(cfg: import("../config/config.js").BitterbotConfig): Promise<void> {
  const { renderSection, ok, error } = await import("./doctor-check.js");
  try {
    const { MemoryIndexManager } = await import("../memory/manager.js");
    const { resolveDefaultAgentId } = await import("../agents/agent-scope.js");
    const mgr = await MemoryIndexManager.get({
      cfg,
      agentId: resolveDefaultAgentId(cfg),
      purpose: "status",
    });
    renderSection("Memory", [
      mgr ? ok("Memory index available.") : error("Memory manager unavailable."),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    renderSection("Memory", [
      error(
        `Memory is OFFLINE — the agent cannot store or recall. ${detail}\n` +
          "Fix: add a provider key in Models & Keys, or keep the keyless local model " +
          "(memory embeddings local.autoDownload) enabled with its optional dependencies installed.",
      ),
    ]);
  }
}
