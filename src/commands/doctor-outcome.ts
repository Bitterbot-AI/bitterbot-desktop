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
 * This module lets sections record their worst severity so `doctorCommand`
 * can exit non-zero when something is genuinely broken, which is what makes
 * the update gate real. It is intentionally tiny and side-effect-scoped:
 * `reset()` at the start of a run, `record()` from sections, `worst()`/
 * `hasError()` at the end.
 *
 * Contract: only `error`-level findings should represent "this node is
 * broken enough that an update must not hand off to it." Degraded-but-usable
 * states stay `warn` so the gate does not over-block on transient conditions.
 */

export type DoctorLevel = "ok" | "warn" | "error" | "info";

const ORDER: Record<DoctorLevel, number> = { info: 0, ok: 1, warn: 2, error: 3 };

let worstLevel: DoctorLevel = "ok";
const errorMessages: string[] = [];

/** One structured finding, for machine-readable (`--json`) output. */
export type DoctorFinding = { section: string; level: DoctorLevel; message: string };
const findings: DoctorFinding[] = [];

/** Reset at the start of each doctor run. */
export function resetDoctorOutcome(): void {
  worstLevel = "ok";
  errorMessages.length = 0;
  findings.length = 0;
}

/** Collect a structured finding (does NOT affect the exit code by itself). */
export function recordFinding(section: string, level: DoctorLevel, message: string): void {
  findings.push({ section, level, message });
}

export function doctorFindings(): readonly DoctorFinding[] {
  return findings;
}

/**
 * The worst level across ALL collected findings (for display). Distinct from
 * `worstDoctorLevel()`, which reflects only exit-code-gated sections — a
 * channel warning shows here but does not block an update.
 */
export function worstFindingLevel(): DoctorLevel {
  let worst: DoctorLevel = "ok";
  for (const f of findings) {
    if (ORDER[f.level] > ORDER[worst]) worst = f.level;
  }
  return worst;
}

/** Record a single finding's level (and message, for error-level). */
export function recordDoctorLevel(level: DoctorLevel, message?: string): void {
  if (ORDER[level] > ORDER[worstLevel]) {
    worstLevel = level;
  }
  if (level === "error" && message) {
    errorMessages.push(message);
  }
}

/** Record the worst level across a section's results array. */
export function recordDoctorResults(
  results: ReadonlyArray<{ level: DoctorLevel; message: string }>,
): void {
  for (const r of results) {
    recordDoctorLevel(r.level, r.message);
  }
}

export function worstDoctorLevel(): DoctorLevel {
  return worstLevel;
}

export function doctorHasError(): boolean {
  return worstLevel === "error";
}

export function doctorErrorMessages(): readonly string[] {
  return errorMessages;
}
