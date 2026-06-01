/**
 * Auto-initiation pre-turn decider (PLAN-22 Phase 3).
 *
 * Bridges the pure complexity gate (Phase 1/2) to the fail-closed seam
 * (Phase 0). Registered once at gateway task-subsystem startup; the seam
 * invokes it after the client ack and before dispatch.
 *
 * Two env flags gate behaviour:
 *   - BITTERBOT_TASKS_COMPLEXITY_GATE (default ON): appraise + log telemetry
 *     only. No task is created and the payload is never mutated.
 *   - BITTERBOT_TASKS_AUTO_INITIATE (default OFF): actually create the Task
 *     and augment the run's extraSystemPrompt with the first slice + ack.
 *
 * The decider only ever augments `extraSystemPrompt`; combined with the
 * seam's fail-closed wrapper, it cannot block or alter the run on any
 * failure path.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { maybeInitiateGoal } from "../../tasks/auto-initiate.js";
import { appraiseComplexity, type ComplexityModulators } from "../../tasks/complexity.js";
import { peekHormonalAccessorState } from "../../tasks/hormonal-accessor.js";
import { registerPreTurnDecider, type PreTurnDecider } from "./pre-turn-decision.js";

const log = createSubsystemLogger("tasks/auto-initiate-decider");

/** Appraisal-only telemetry, on by default. Disable with "0". */
export function isComplexityGateEnabled(): boolean {
  return process.env.BITTERBOT_TASKS_COMPLEXITY_GATE !== "0";
}

/** Actual task creation, off by default. Enable with "1" / "true". */
export function isAutoInitiateEnabled(): boolean {
  const v = process.env.BITTERBOT_TASKS_AUTO_INITIATE;
  return v === "1" || v === "true";
}

/**
 * Map the live hormonal snapshot into the gate's modulators. GCCRF curiosity
 * is not yet plumbed here; omitted modulators are treated as neutral, so the
 * gate degrades gracefully to the cortisol/dopamine signals.
 */
export function readModulators(): ComplexityModulators {
  const h = peekHormonalAccessorState();
  if (!h) {
    return {};
  }
  return { cortisol: h.cortisol, dopamine: h.dopamine };
}

export interface AutoInitiationDeciderDeps {
  autoEnabled?: () => boolean;
  gateEnabled?: () => boolean;
  modulators?: () => ComplexityModulators;
  initiate?: typeof maybeInitiateGoal;
}

/** Build the decider closure (deps injectable for unit testing). */
export function buildAutoInitiationDecider(deps: AutoInitiationDeciderDeps = {}): PreTurnDecider {
  const autoEnabled = deps.autoEnabled ?? isAutoInitiateEnabled;
  const gateEnabled = deps.gateEnabled ?? isComplexityGateEnabled;
  const readMods = deps.modulators ?? readModulators;
  const initiate = deps.initiate ?? maybeInitiateGoal;

  return async (payload, ctx) => {
    const auto = autoEnabled();
    const gate = gateEnabled();
    if (!auto && !gate) {
      return payload;
    }

    const modulators = readMods();

    if (!auto) {
      // Telemetry only: appraise (pure), log, never create or mutate.
      const verdict = appraiseComplexity(payload.message, modulators);
      if (verdict.tier !== "inline") {
        log.debug(
          `complexity gate (telemetry): tier=${verdict.tier} score=${verdict.score.toFixed(3)} thresholds=[${verdict.thresholds.low.toFixed(2)},${verdict.thresholds.high.toFixed(2)}]`,
        );
      }
      return payload;
    }

    const decision = await initiate(
      { prompt: payload.message, agentSessionKey: ctx.sessionKey, source: "user" },
      { modulators },
    );
    if (decision.mode !== "task") {
      return payload;
    }

    const slice = `${decision.firstSlice}\n\nBegin your reply by telling the user: ${decision.ack}`;
    const extraSystemPrompt = payload.extraSystemPrompt
      ? `${payload.extraSystemPrompt}\n\n${slice}`
      : slice;
    log.info(`auto-initiation augmented run for task ${decision.taskId}`);
    return { message: payload.message, extraSystemPrompt };
  };
}

/** Register the auto-initiation decider with the pre-turn seam. */
export function registerAutoInitiation(deps?: AutoInitiationDeciderDeps): void {
  registerPreTurnDecider(buildAutoInitiationDecider(deps));
  log.info(
    `auto-initiation decider registered (gate=${isComplexityGateEnabled()} auto=${isAutoInitiateEnabled()})`,
  );
}
