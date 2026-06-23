/**
 * PLAN-20 Phase 1: runner that drives registered pre-action interceptors
 * for a candidate tool call.
 *
 * Called by `runBeforeToolCallHook` in pi-tools.before-tool-call.ts BEFORE
 * plugin hooks. Returns either:
 *  - { kind: "pass", params } — no interceptor fired (or all NOOP)
 *  - { kind: "modify", params, fired }
 *  - { kind: "inject", contextText, fired }    (caller decides where to inject)
 *  - { kind: "require_prereq", tool, params, fired }
 *  - { kind: "block", reason, userVisibleMessage?, fired }
 *
 * Every non-NOOP firing produces a signed InterventionRecord persisted
 * through `setInterventionStore`. The outcome signal is patched in later
 * by experience-signal-collector once the downstream effect is visible.
 */

import { randomUUID } from "node:crypto";
import type {
  CandidateAction,
  Intervention,
  RegisteredInterceptor,
  StepContext,
} from "./interceptor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ensureInterceptorsAutoBoot } from "./interceptor-autoboot.js";
import { resolveStepContext } from "./interceptor-context.js";
import { getInterceptorRegistry } from "./interceptor-registry.js";
import { getInterceptorStrikesStore } from "./interceptor-strikes-store.js";
import {
  getInterventionStore,
  signInterventionRecord,
  type InterventionRecord,
} from "./intervention-record.js";
import { recordTool } from "./session-context-tracker.js";

const MESSAGE_TOOL_HINT_RX = /(send_message|_send|_reply|send$|reply$|^message$)/i;
const TEXT_PARAM_KEYS = ["text", "content", "message", "body", "reply"] as const;

function autoExtractDraft(
  toolName: string,
  params: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!MESSAGE_TOOL_HINT_RX.test(toolName)) return undefined;
  for (const key of TEXT_PARAM_KEYS) {
    const v = params[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

const log = createSubsystemLogger("agents/skills/interceptors");

const LATENCY_BUDGET_MS = 50;
const FAILURE_STRIKES_THRESHOLD = 3;

export type InterceptorOutcome =
  | { kind: "pass"; params: Readonly<Record<string, unknown>> }
  | {
      kind: "modify";
      params: Record<string, unknown>;
      reason: string;
      firedId: string;
    }
  | {
      kind: "inject";
      contextText: string;
      reason: string;
      firedId: string;
    }
  | {
      kind: "require_prereq";
      tool: string;
      params: Record<string, unknown>;
      reason: string;
      firedId: string;
    }
  | {
      kind: "block";
      reason: string;
      userVisibleMessage?: string;
      firedId: string;
    };

interface RunArgs {
  toolName: string;
  params: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
}

const failureStrikesPerSession = new Map<string, Map<string, number>>();

function bumpStrike(sessionKey: string, interceptorId: string, reason: string): number {
  let session = failureStrikesPerSession.get(sessionKey);
  if (!session) {
    session = new Map();
    failureStrikesPerSession.set(sessionKey, session);
  }
  const sessionStrikes = (session.get(interceptorId) ?? 0) + 1;
  session.set(interceptorId, sessionStrikes);

  // Mirror to the persistent SQLite store when available. The persistent
  // counter survives gateway restarts; the in-process Map handles the
  // hot-path check. Both must agree on the 3-strikes threshold.
  const store = getInterceptorStrikesStore();
  if (store) {
    try {
      store.recordStrike(interceptorId, reason);
    } catch {
      // Best-effort.
    }
  }
  return sessionStrikes;
}

function withinFireLimit(
  registry: ReturnType<typeof getInterceptorRegistry>,
  sessionKey: string,
  entry: RegisteredInterceptor,
): boolean {
  const cap = entry.interceptor.maxFiresPerEpisode;
  if (cap === undefined) return true;
  return registry.firesThisEpisode(sessionKey, entry.interceptor.id) < cap;
}

async function evaluateOne(
  entry: RegisteredInterceptor,
  args: RunArgs,
  sessionKey: string,
  ctxBuilder: () => ReturnType<typeof resolveStepContext>,
): Promise<{
  intervention: Intervention;
  latency: { activate: number; intervene: number };
} | null> {
  const interceptor = entry.interceptor;
  const candidate = { toolName: args.toolName, params: args.params };

  const ctx = ctxBuilder();
  const activateStart = performance.now();
  let activated = false;
  try {
    activated = await interceptor.shouldActivate(ctx, candidate);
  } catch (err) {
    const strikes = bumpStrike(sessionKey, interceptor.id, String(err));
    getInterceptorRegistry().markFailure(interceptor.id, strikes);
    log.warn(
      `interceptor.shouldActivate threw: id=${interceptor.id} err=${String(err)} strikes=${strikes}`,
    );
    return null;
  }
  const activateLatency = performance.now() - activateStart;
  if (!activated) return null;

  const interveneStart = performance.now();
  let intervention: Intervention;
  try {
    intervention = await interceptor.intervene(ctx, candidate);
  } catch (err) {
    const strikes = bumpStrike(sessionKey, interceptor.id, String(err));
    getInterceptorRegistry().markFailure(interceptor.id, strikes);
    log.warn(
      `interceptor.intervene threw: id=${interceptor.id} err=${String(err)} strikes=${strikes}`,
    );
    return null;
  }
  const interveneLatency = performance.now() - interveneStart;

  return {
    intervention,
    latency: { activate: activateLatency, intervene: interveneLatency },
  };
}

function persistAndEmit(args: {
  interceptor: RegisteredInterceptor["interceptor"];
  sessionKey: string;
  agentId: string;
  channel: string;
  hormonal: ReturnType<typeof resolveStepContext>["hormonal"];
  gccrf: ReturnType<typeof resolveStepContext>["gccrf"];
  toolName: string;
  paramsOriginal: Record<string, unknown>;
  intervention: Intervention;
  paramsFinal: Record<string, unknown> | null;
  latency: { activate: number; intervene: number };
}): string {
  const id = randomUUID();
  const ts = Date.now();
  const rec: Omit<InterventionRecord, "sig"> = {
    id,
    ts,
    sessionKey: args.sessionKey,
    skill: args.interceptor.skill,
    interceptorId: args.interceptor.id,
    stateSummary: {
      hormonal: args.hormonal,
      gccrf: args.gccrf,
      channel: args.channel,
    },
    actionOriginal: { toolName: args.toolName, params: args.paramsOriginal },
    actionFinal:
      args.paramsFinal !== null ? { toolName: args.toolName, params: args.paramsFinal } : null,
    intervention: args.intervention,
    metadata: {
      activationLatencyMs: Math.round(args.latency.activate * 100) / 100,
      interventionLatencyMs: Math.round(args.latency.intervene * 100) / 100,
    },
  };
  const signed = signInterventionRecord(rec);
  const store = getInterventionStore();
  try {
    store?.insert(signed);
  } catch (err) {
    log.warn(`intervention store insert failed: id=${id} err=${String(err)}`);
  }

  // Publish a UI-facing event. The AgentEventStream type accepts arbitrary
  // string streams via `(string & {})`, so "intervention" is well-typed.
  try {
    emitAgentEvent({
      stream: "intervention",
      runId: args.sessionKey,
      sessionKey: args.sessionKey,
      data: {
        id,
        ts,
        skill: args.interceptor.skill,
        interceptorId: args.interceptor.id,
        toolName: args.toolName,
        intervention: args.intervention,
        latencyMs: rec.metadata.interventionLatencyMs + rec.metadata.activationLatencyMs,
      },
    });
  } catch {
    // emitter not registered in this process — fine, UI just won't see it
  }
  return id;
}

export async function runInterceptors(args: RunArgs): Promise<InterceptorOutcome> {
  ensureInterceptorsAutoBoot();
  const registry = getInterceptorRegistry();
  const sessionKey = args.sessionKey ?? "__anon__";
  const agentId = args.agentId ?? "default";

  const candidates = registry.candidatesFor(args.toolName);
  if (candidates.length === 0) {
    return { kind: "pass", params: args.params };
  }

  // Auto-extract draftReply from action params when the tool name looks
  // like a message-send shape (Discord/Telegram/WhatsApp/Slack/...). The
  // canonical param keys vary per channel; we accept the common shapes.
  const autoDraft = autoExtractDraft(args.toolName, args.params);

  const ctxBuilder = () => {
    const base = resolveStepContext({ sessionKey, agentId });
    if (autoDraft && !base.draftReply) {
      return Object.freeze({ ...base, draftReply: autoDraft }) as StepContext;
    }
    return base;
  };
  // Build ctx once eagerly for shared snapshot fields; rebuild on demand
  // if we ever change `draftReply` to update mid-evaluation (we don't today).
  const ctx0 = ctxBuilder();

  let currentParams: Record<string, unknown> = args.params;
  let injectedContext: { text: string; reason: string; firedId: string } | null = null;
  const start = performance.now();

  for (const entry of candidates) {
    if (performance.now() - start > LATENCY_BUDGET_MS) {
      log.debug(`interceptor budget exceeded; skipping remaining (tool=${args.toolName})`);
      break;
    }
    if (!withinFireLimit(registry, sessionKey, entry)) continue;

    const result = await evaluateOne(
      entry,
      { ...args, params: currentParams },
      sessionKey,
      () => ctx0,
    );
    if (!result) continue;
    if (result.intervention.type === "noop") continue;

    registry.recordFire(sessionKey, entry.interceptor.id);

    const channel = ctx0.channel;
    const recordId = persistAndEmit({
      interceptor: entry.interceptor,
      sessionKey,
      agentId,
      channel,
      hormonal: ctx0.hormonal,
      gccrf: ctx0.gccrf,
      toolName: args.toolName,
      paramsOriginal: args.params,
      intervention: result.intervention,
      paramsFinal:
        result.intervention.type === "modify"
          ? result.intervention.newParams
          : result.intervention.type === "block"
            ? null
            : currentParams,
      latency: result.latency,
    });

    switch (result.intervention.type) {
      case "modify": {
        currentParams = result.intervention.newParams;
        // continue letting lower-priority interceptors see the modified
        // params (deliberate compose semantics)
        break;
      }
      case "inject": {
        injectedContext = {
          text: result.intervention.contextText,
          reason: result.intervention.reason,
          firedId: recordId,
        };
        // continue; final outcome packed below
        break;
      }
      case "require_prereq": {
        return {
          kind: "require_prereq",
          tool: result.intervention.tool,
          params: result.intervention.params,
          reason: result.intervention.reason,
          firedId: recordId,
        };
      }
      case "block": {
        return {
          kind: "block",
          reason: result.intervention.reason,
          userVisibleMessage: result.intervention.userVisibleMessage,
          firedId: recordId,
        };
      }
    }
  }

  if (injectedContext) {
    return {
      kind: "inject",
      contextText: injectedContext.text,
      reason: injectedContext.reason,
      firedId: injectedContext.firedId,
    };
  }
  if (currentParams !== args.params) {
    return {
      kind: "modify",
      params: currentParams,
      reason: "composite",
      firedId: "composite",
    };
  }
  return { kind: "pass", params: args.params };
}

export function resetInterceptorRunnerState(): void {
  failureStrikesPerSession.clear();
}

export const __testing = {
  LATENCY_BUDGET_MS,
  FAILURE_STRIKES_THRESHOLD,
  failureStrikesPerSession,
};
