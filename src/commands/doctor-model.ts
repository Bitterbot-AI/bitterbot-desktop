/**
 * The single highest-value fidelity check: ONE real end-to-end model
 * round-trip. Doctor otherwise validates the model by catalog membership and
 * key presence — "configured", never "works". That gap is exactly how the
 * 2026-07-21 regression (a `temperature` param that made Opus 4.8 400 every
 * request, masked by completeSimple as "no text content") shipped silently.
 *
 * This runs the SAME clean call path production uses (createJudgeLlmCall: no
 * sampling params, surfaces embedded provider errors), so if that path breaks
 * again, doctor catches it — and because it is error-level, it blocks the
 * update gate.
 *
 * Severity is deliberately calibrated so the gate does not over-block:
 *   - success            → ok
 *   - missing/invalid key → warn  (can't verify ≠ broken; a keyless node must
 *                                  still be allowed to update)
 *   - network/timeout/5xx/rate → warn (transient/environmental)
 *   - 4xx param rejection, stopReason=error, empty-with-credentials → ERROR
 *     (the request was well-formed and the provider actively rejected it, or
 *     returned a masked error — the call path is genuinely broken)
 */

import type { BitterbotConfig } from "../config/config.js";
import { note } from "../terminal/note.js";
import { recordDoctorLevel } from "./doctor-outcome.js";

type Level = "ok" | "warn" | "error" | "info";
export type ModelCheckOutcome =
  | { kind: "ok"; latencyMs: number; sample: string }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

// Generous headroom: a healthy "reply OK" is ~2s, but a cold process's first
// call (DNS + TLS + model latency) can spike. A false timeout only downgrades
// to a warn, never blocks — but the headroom keeps healthy nodes reporting ok.
const MODEL_CHECK_TIMEOUT_MS = 40_000;
const PROMPT = "Reply with the single word: OK";

/** True for errors that mean "we couldn't test", not "the path is broken". */
function isCredentialError(msg: string): boolean {
  return /\b(api[_ -]?key|apikey|unauthorized|authentication|401|403|no api key|missing key|no.*credential|not registered)\b/i.test(
    msg,
  );
}

/** True for transient/environmental errors that should not block an update. */
function isTransientError(msg: string): boolean {
  if (
    /\b(timeout|etimedout|econnreset|econnrefused|socket hang up|network|fetch failed|enotfound)\b/i.test(
      msg,
    )
  )
    return true;
  if (/\b(429|rate)\b/i.test(msg)) return true;
  for (let i = 500; i < 600; i += 1) if (msg.includes(`${i}`)) return true;
  return false;
}

/**
 * Pure severity classifier — exported for tests so the calibration (which
 * failures block the update gate) is verified without a live model call.
 */
export function classifyModelCheck(outcome: ModelCheckOutcome): { level: Level; message: string } {
  if (outcome.kind === "ok") {
    return {
      level: "ok",
      message: `Model round-trip succeeded in ${outcome.latencyMs}ms (reply: "${outcome.sample}").`,
    };
  }
  if (outcome.kind === "skipped") {
    return { level: "info", message: `Model round-trip skipped: ${outcome.reason}.` };
  }
  const msg = outcome.message;
  if (isCredentialError(msg)) {
    return {
      level: "warn",
      message:
        `Could not verify the model path — no usable credentials (${msg}). ` +
        `Set one with \`bitterbot models auth\`. Not treated as broken.`,
    };
  }
  if (isTransientError(msg)) {
    return {
      level: "warn",
      message: `Model round-trip failed transiently (${msg}). Likely network/rate-limit, not a broken build.`,
    };
  }
  return {
    level: "error",
    message:
      `Model round-trip FAILED: ${msg}. The configured model path is broken — ` +
      `every agent turn, judge, and draft will fail. (This is the class of the temperature-on-Opus regression.)`,
  };
}

function shouldSkipInTest(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

/** Perform the live round-trip and return a structured outcome. */
export async function runModelRoundTrip(cfg: BitterbotConfig): Promise<ModelCheckOutcome> {
  if (shouldSkipInTest()) {
    return { kind: "skipped", reason: "test environment" };
  }
  try {
    const { createJudgeLlmCall } = await import("../tasks/judge-provider.js");
    // Same clean call path production uses. Single attempt keeps it a fast,
    // predictable "one round-trip": a transient blip is already classified as
    // warn, and a definitive rejection (400 param) won't change on retry.
    const call = createJudgeLlmCall(cfg, { maxTokens: 16, attempts: 1 });
    const started = Date.now();
    const text = await Promise.race([
      call(PROMPT),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), MODEL_CHECK_TIMEOUT_MS),
      ),
    ]);
    const latencyMs = Date.now() - started;
    const sample = text.trim().slice(0, 40) || "(empty)";
    return { kind: "ok", latencyMs, sample };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Doctor section: one live model round-trip, classified and recorded. */
export async function runModelCheck(params: { config: BitterbotConfig }): Promise<void> {
  const outcome = await runModelRoundTrip(params.config);
  const result = classifyModelCheck(outcome);
  recordDoctorLevel(result.level, result.level === "error" ? "model round-trip failed" : undefined);
  const icon =
    result.level === "ok"
      ? "✔"
      : result.level === "warn"
        ? "⚠"
        : result.level === "error"
          ? "✘"
          : "ℹ";
  note(`${icon} ${result.message}`, "Model Round-Trip");
}
