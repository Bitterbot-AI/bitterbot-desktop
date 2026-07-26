/**
 * The shared doctor check contract.
 *
 * Every section used to re-declare its own byte-identical copy of this block
 * (Level / CheckResult / ok / warn / error / info / formatLevel /
 * renderSection) and then render results to `note()` and throw them away.
 * That copy-paste is exactly why doctor drifted — 28 divergent implementations
 * of the same enum, and nothing could aggregate results for an exit code, a
 * `--json` surface, or a live UI. This module is the single source of truth
 * every section imports instead.
 *
 * `renderSection` collects each result as a structured finding (for `--json`)
 * and prints it (unless JSON mode suppresses console output). It does NOT feed
 * the exit-code accumulator by default — that stays curated to build/boot
 * health so the update gate does not over-block on, say, a channel-credential
 * warning. Pass `{ gateExitCode: true }` for sections whose errors genuinely
 * mean "this node is broken enough to block an update".
 */

import { note } from "../terminal/note.js";
import { recordDoctorLevel, recordFinding } from "./doctor-outcome.js";

export type DoctorLevel = "ok" | "warn" | "error" | "info";
export type CheckResult = { level: DoctorLevel; message: string };

export const ok = (message: string): CheckResult => ({ level: "ok", message });
export const warn = (message: string): CheckResult => ({ level: "warn", message });
export const error = (message: string): CheckResult => ({ level: "error", message });
export const info = (message: string): CheckResult => ({ level: "info", message });

export function formatLevel(r: CheckResult): string {
  switch (r.level) {
    case "ok":
      return `✔ ${r.message}`;
    case "warn":
      return `⚠ ${r.message}`;
    case "error":
      return `✘ ${r.message}`;
    case "info":
      return `ℹ ${r.message}`;
  }
}

let jsonMode = false;

/** Suppress console rendering (collect-only) when emitting machine output. */
export function setDoctorJsonMode(value: boolean): void {
  jsonMode = value;
}

export function isDoctorJsonMode(): boolean {
  return jsonMode;
}

/**
 * Collect + (unless JSON mode) print a section's results. `gateExitCode` opts
 * the section's severity into the process exit code.
 */
export function renderSection(
  title: string,
  results: CheckResult[],
  opts?: { gateExitCode?: boolean },
): void {
  if (results.length === 0) return;
  for (const r of results) {
    recordFinding(title, r.level, r.message);
    if (opts?.gateExitCode) {
      recordDoctorLevel(r.level, r.level === "error" ? r.message : undefined);
    }
  }
  if (!jsonMode) {
    note(results.map(formatLevel).join("\n"), title);
  }
}
