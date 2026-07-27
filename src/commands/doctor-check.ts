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
 * `renderSection` collects each result as a structured finding (for `--json`
 * and the exit code) and prints it (unless JSON mode suppresses console
 * output).
 *
 * Severity IS the gate: an `error`-level result always fails the process and
 * blocks the update handoff. There is no per-section opt-in — that produced
 * sections whose "errors" were decorative, the exact disease this contract
 * exists to cure. The calibration burden sits where it belongs, on the
 * severity choice:
 *
 *   - error → "this node is broken enough that an update must NOT hand off
 *     to it" (corrupt DB, missing core tables, a provider actively rejecting
 *     well-formed requests, unsupported Node)
 *   - warn  → degraded-but-usable, misconfigured, or unverifiable state.
 *     A keyless wallet, an unreachable relay, or a missing GENOME.md must
 *     never block an update.
 */

import { note } from "../terminal/note.js";
import { recordFinding } from "./doctor-outcome.js";

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
 * Collect + (unless JSON mode) print a section's results. Every result feeds
 * the structured findings, and error-level results fail the run (see module
 * doc: severity is the gate).
 */
export function renderSection(title: string, results: CheckResult[]): void {
  if (results.length === 0) return;
  for (const r of results) {
    recordFinding(title, r.level, r.message);
  }
  if (!jsonMode) {
    note(results.map(formatLevel).join("\n"), title);
  }
}
