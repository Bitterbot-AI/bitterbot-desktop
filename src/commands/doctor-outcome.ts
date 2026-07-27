/**
 * Per-run doctor outcome accumulator.
 *
 * Historically `bitterbot doctor` printed findings and threw them away: an
 * `error`-level result was just a red line, and the process always exited 0.
 * That made the doctor gate in the update flow (`update-runner.ts` runs
 * `bitterbot doctor --non-interactive` and only proceeds if exitCode === 0)
 * effectively decorative — it caught a doctor *crash*, never a doctor
 * *finding*.
 *
 * The structured findings list is the single source of truth: the `--json`
 * report emits it verbatim, and the exit code / update gate derive from it
 * (any error-level finding fails the run). There is no separate severity
 * accumulator — an earlier design kept one, fed only by opted-in sections,
 * which let `--json` report `worstLevel: "error"` alongside `hasError: false`
 * from the same run. One list, one truth.
 *
 * Contract: only `error`-level findings represent "this node is broken
 * enough that an update must not hand off to it." Degraded-but-usable states
 * stay `warn` so the gate does not over-block on transient conditions.
 */

export type DoctorLevel = "ok" | "warn" | "error" | "info";

const ORDER: Record<DoctorLevel, number> = { info: 0, ok: 1, warn: 2, error: 3 };

/** One structured finding, for machine-readable (`--json`) output. */
export type DoctorFinding = { section: string; level: DoctorLevel; message: string };
const findings: DoctorFinding[] = [];

/** Reset at the start of each doctor run. */
export function resetDoctorOutcome(): void {
  findings.length = 0;
}

/** Collect a structured finding. Error-level findings fail the run. */
export function recordFinding(section: string, level: DoctorLevel, message: string): void {
  findings.push({ section, level, message });
}

export function doctorFindings(): readonly DoctorFinding[] {
  return findings;
}

/** The worst level across all collected findings. */
export function worstFindingLevel(): DoctorLevel {
  let worst: DoctorLevel = "ok";
  for (const f of findings) {
    if (ORDER[f.level] > ORDER[worst]) worst = f.level;
  }
  return worst;
}

/** Alias kept for callers that frame the question as "does this run gate?". */
export function worstDoctorLevel(): DoctorLevel {
  return worstFindingLevel();
}

export function doctorHasError(): boolean {
  return findings.some((f) => f.level === "error");
}

export function doctorErrorMessages(): string[] {
  return findings.filter((f) => f.level === "error").map((f) => f.message);
}
