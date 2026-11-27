import crypto from "node:crypto";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { resolveActiveProjectName } from "../../agents/canonical-facts-block.js";
import { resolveUserTimezone } from "../../agents/date-time.js";
import { runEmbeddedPiAgent } from "../../agents/embedded.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import type { BitterbotConfig } from "../../config/config.js";
import {
  practiceAttributionEnabled,
  practiceFollowUpsEnabled,
  practiceOffersEnabled,
  practicesEnabled,
} from "../../config/feature-switches.js";
import {
  resolveAgentIdFromSessionKey,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import {
  CORRECTION_CAPTURE_TIMEOUT_MS,
  matchesCorrectionPrefilter,
  resolveCorrectionSkipReason,
  runCorrectionCapture,
} from "../../memory/correction-capture.js";
import { classifySessionKeyTrust } from "../../memory/session-trust.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import { buildThreadingToolContext, resolveEnforceFinalTag } from "./agent-runner-utils.js";
import {
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";
import type { FollowupRun } from "./queue.js";
import { incrementCompactionCount } from "./session-updates.js";

export async function runMemoryFlushIfNeeded(params: {
  cfg: BitterbotConfig;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
}): Promise<SessionEntry | undefined> {
  const memoryFlushSettings = resolveMemoryFlushSettings(params.cfg);
  if (!memoryFlushSettings) {
    return params.sessionEntry;
  }

  const memoryFlushWritable = (() => {
    if (!params.sessionKey) {
      return true;
    }
    const runtime = resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!runtime.sandboxed) {
      return true;
    }
    const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
    return sandboxCfg.workspaceAccess === "rw";
  })();

  const shouldFlushMemory =
    memoryFlushSettings &&
    memoryFlushWritable &&
    !params.isHeartbeat &&
    !isCliProvider(params.followupRun.run.provider, params.cfg) &&
    shouldRunMemoryFlush({
      entry:
        params.sessionEntry ??
        (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined),
      contextWindowTokens: resolveMemoryFlushContextWindowTokens({
        modelId: params.followupRun.run.model ?? params.defaultModel,
        agentCfgContextTokens: params.agentCfgContextTokens,
      }),
      reserveTokensFloor: memoryFlushSettings.reserveTokensFloor,
      softThresholdTokens: memoryFlushSettings.softThresholdTokens,
    });

  if (!shouldFlushMemory) {
    return params.sessionEntry;
  }

  let activeSessionEntry = params.sessionEntry;
  const activeSessionStore = params.sessionStore;
  const flushRunId = crypto.randomUUID();
  if (params.sessionKey) {
    registerAgentRunContext(flushRunId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
    });
  }
  let memoryCompactionCompleted = false;
  const flushSystemPrompt = [
    params.followupRun.run.extraSystemPrompt,
    memoryFlushSettings.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    await runWithModelFallback({
      cfg: params.followupRun.run.config,
      provider: params.followupRun.run.provider,
      model: params.followupRun.run.model,
      agentDir: params.followupRun.run.agentDir,
      fallbacksOverride: resolveAgentModelFallbacksOverride(
        params.followupRun.run.config,
        resolveAgentIdFromSessionKey(params.followupRun.run.sessionKey),
      ),
      run: (provider, model) => {
        const authProfileId =
          provider === params.followupRun.run.provider
            ? params.followupRun.run.authProfileId
            : undefined;
        return runEmbeddedPiAgent({
          sessionId: params.followupRun.run.sessionId,
          sessionKey: params.sessionKey,
          agentId: params.followupRun.run.agentId,
          messageProvider: params.sessionCtx.Provider?.trim().toLowerCase() || undefined,
          agentAccountId: params.sessionCtx.AccountId,
          messageTo: params.sessionCtx.OriginatingTo ?? params.sessionCtx.To,
          messageThreadId: params.sessionCtx.MessageThreadId ?? undefined,
          // Provider threading context for tool auto-injection
          ...buildThreadingToolContext({
            sessionCtx: params.sessionCtx,
            config: params.followupRun.run.config,
            hasRepliedRef: params.opts?.hasRepliedRef,
          }),
          senderId: params.sessionCtx.SenderId?.trim() || undefined,
          senderName: params.sessionCtx.SenderName?.trim() || undefined,
          senderUsername: params.sessionCtx.SenderUsername?.trim() || undefined,
          senderE164: params.sessionCtx.SenderE164?.trim() || undefined,
          sessionFile: params.followupRun.run.sessionFile,
          workspaceDir: params.followupRun.run.workspaceDir,
          agentDir: params.followupRun.run.agentDir,
          config: params.followupRun.run.config,
          skillsSnapshot: params.followupRun.run.skillsSnapshot,
          prompt: resolveMemoryFlushPromptForRun({
            prompt: memoryFlushSettings.prompt,
            cfg: params.cfg,
          }),
          extraSystemPrompt: flushSystemPrompt,
          ownerNumbers: params.followupRun.run.ownerNumbers,
          enforceFinalTag: resolveEnforceFinalTag(params.followupRun.run, provider),
          provider,
          model,
          authProfileId,
          authProfileIdSource: authProfileId
            ? params.followupRun.run.authProfileIdSource
            : undefined,
          thinkLevel: params.followupRun.run.thinkLevel,
          verboseLevel: params.followupRun.run.verboseLevel,
          reasoningLevel: params.followupRun.run.reasoningLevel,
          execOverrides: params.followupRun.run.execOverrides,
          bashElevated: params.followupRun.run.bashElevated,
          timeoutMs: params.followupRun.run.timeoutMs,
          runId: flushRunId,
          onAgentEvent: (evt) => {
            if (evt.stream === "compaction") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              if (phase === "end") {
                memoryCompactionCompleted = true;
              }
            }
          },
        });
      },
    });
    let memoryFlushCompactionCount =
      activeSessionEntry?.compactionCount ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.compactionCount : 0) ??
      0;
    if (memoryCompactionCompleted) {
      const nextCount = await incrementCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
      if (typeof nextCount === "number") {
        memoryFlushCompactionCount = nextCount;
      }
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({
            memoryFlushAt: Date.now(),
            memoryFlushCompactionCount,
          }),
        });
        if (updatedEntry) {
          activeSessionEntry = updatedEntry;
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }
    }
  } catch (err) {
    logVerbose(`memory flush run failed: ${String(err)}`);
  }

  return activeSessionEntry;
}

/**
 * PLAN-55 Phase 1 review (item 9): a message steered into a running turn
 * (`queueEmbeddedPiMessage`) never gets its own run completion. It is kept
 * here by session id and captured when the running turn completes.
 */
const STEERED_TURNS = new Map<string, string[]>();
const MAX_STEERED_PER_SESSION = 8;

export function rememberSteeredUserTurn(sessionId: string, userBody: string): void {
  const text = userBody.trim();
  if (!text) {
    return;
  }
  const list = STEERED_TURNS.get(sessionId) ?? [];
  list.push(text);
  STEERED_TURNS.set(sessionId, list.slice(-MAX_STEERED_PER_SESSION));
}

export function takeSteeredUserTurns(sessionId: string): string[] {
  const list = STEERED_TURNS.get(sessionId) ?? [];
  STEERED_TURNS.delete(sessionId);
  return list;
}

/** The slice of the memory manager the attribution line reads. */
type AttributionManager = {
  practices?: () => import("../../memory/practices.js").PracticesStore;
  taskTypes?: () => { get: (slug: string) => { label: string } | null };
};

/**
 * PLAN-64 Phase 3: the generated "Applied: ..." line for a reply whose
 * prompt carried a scoped practice through a real scope match, or null.
 * Direct chats of the owner only: never a heartbeat, a cron job's session, a
 * group, a guest or a subagent, and never a turn that produced no reply
 * text. The caller drops it when the reply already carries a "Memory
 * updated", "Practice saved" or offer line. Reads the manager only when one
 * is already open (the prompt path opened it to render the practice). No
 * model call. Never throws.
 */
export async function resolvePracticeAttribution(params: {
  cfg: BitterbotConfig;
  followupRun: FollowupRun;
  sessionKey?: string;
  replyText: string;
  isHeartbeat: boolean;
  chatType?: string;
  runStartedAt: number;
  /** The manager the caller already holds; peeked otherwise. */
  manager?: AttributionManager | null;
}): Promise<string | null> {
  try {
    const run = params.followupRun.run;
    const sessionKey = params.sessionKey ?? run.sessionKey;
    if (
      !practiceAttributionEnabled(params.cfg.memory?.practices) ||
      params.isHeartbeat ||
      run.senderIsOwner !== true ||
      !sessionKey ||
      isCronSessionKey(sessionKey) ||
      classifySessionKeyTrust(sessionKey) !== "first_party" ||
      (params.chatType && params.chatType.toLowerCase() !== "direct") ||
      !params.replyText.trim() ||
      !run.sessionFile
    ) {
      return null;
    }
    let manager = params.manager;
    if (manager === undefined) {
      const { peekMemorySearchManager } = await import("../../memory/index.js");
      manager = (await peekMemorySearchManager({ cfg: params.cfg, agentId: run.agentId }))
        .manager as unknown as AttributionManager | null;
    }
    const store = manager?.practices?.();
    if (!store) {
      return null;
    }
    const { resolveAttributionLine } = await import("../../memory/practice-attribution.js");
    return resolveAttributionLine(store, {
      sessionFile: run.sessionFile,
      since: params.runStartedAt,
      taskLabel: (slug) => manager?.taskTypes?.().get(slug)?.label,
      timeZone: resolveUserTimezone(params.cfg.agents?.defaults?.userTimezone),
    });
  } catch (err) {
    logVerbose(`practice attribution failed: ${String(err)}`);
    return null;
  }
}

/**
 * PLAN-55 Phase 1: the per-turn correction capture, on run completion of a
 * first-party owner turn (the reply runner, the followup runner, and the
 * turns a steered message joined). Returns the one-line "Memory updated"
 * confirmation to append to the reply, or null. PLAN-64 Phase 1b: the same
 * hook runs follow-up learning around the pass (the follow-up check shares
 * the pass's one model call; the generated offer and offer-answer lines join
 * the returned text). PLAN-64 Phase 3: when the turn produced none of those
 * lines, the reply may carry the practice attribution line instead (those
 * lines win; a reply never carries both). Cheap gates run before the
 * memory manager is touched; the whole pass is bounded by
 * CORRECTION_CAPTURE_TIMEOUT_MS, which also ABORTS the model call (review
 * item 12: a timed-out call must not bill and write later), and never
 * throws into the reply path.
 */
export async function runCorrectionCaptureAfterTurn(params: {
  cfg: BitterbotConfig;
  followupRun: FollowupRun;
  sessionKey?: string;
  /** The prompt as sent; only the fallback when `followupRun.userBody` is absent. */
  commandBody: string;
  replyText: string;
  isHeartbeat: boolean;
  chatType?: string;
  runStartedAt: number;
}): Promise<string | null> {
  const run = params.followupRun.run;
  // The owner's own words (review item 3): the raw inbound body, never the
  // prompt with its reply/quote/forward blocks, thread history, untrusted
  // context or system events. Steered messages join this turn.
  const primary = params.followupRun.userBody ?? params.commandBody;
  const skipped = resolveCorrectionSkipReason({
    cfg: params.cfg,
    sessionKey: params.sessionKey ?? run.sessionKey,
    senderIsOwner: run.senderIsOwner === true,
    isHeartbeat: params.isHeartbeat,
    userMessage: primary,
  });
  if (skipped) {
    // Steered messages stay queued for the next owner completion in this
    // session (a heartbeat completing is not the owner's turn).
    // With capture switched off or in incognito, stored practices are still
    // rendered, so the attribution line still applies (its own gates decide).
    return skipped === "disabled" || skipped === "session-memory-off"
      ? await resolvePracticeAttribution(params)
      : null;
  }
  const userMessages = [primary, ...takeSteeredUserTurns(run.sessionId)].filter((text) =>
    text.trim(),
  );
  const abort = new AbortController();
  const work = (async (): Promise<string | null> => {
    const { getMemorySearchManager, peekMemorySearchManager } =
      await import("../../memory/index.js");
    // A corrective shape earns the model call and may open the memory
    // manager. Any other turn only reads what the run itself wrote (an
    // agent pin, a held supersede), which exists only if something already
    // opened the manager: never open the memory database for a plain turn.
    const anyHit = userMessages.some((text) => matchesCorrectionPrefilter(text) !== null);
    const { manager } = anyHit
      ? await getMemorySearchManager({ cfg: params.cfg, agentId: run.agentId })
      : await peekMemorySearchManager({ cfg: params.cfg, agentId: run.agentId });
    const m = manager as unknown as
      | {
          canonicalFacts?: () =>
            | import("../../memory/canonical-facts.js").CanonicalFactsStore
            | null;
          ownerPinFact?: (
            input: import("../../memory/owner-controls.js").OwnerPinInput,
          ) => Promise<import("../../memory/owner-controls.js").OwnerPinResult>;
          correctionLlmCall?: () =>
            | import("../../memory/correction-capture.js").CorrectionLlmCall
            | null;
          // PLAN-64 Phase 1: practices ride on the same pass.
          practices?: () => import("../../memory/practices.js").PracticesStore;
          // PLAN-64 Phase 3: the attribution line shows a task scope by its label.
          taskTypes?: () => { get: (slug: string) => { label: string } | null };
          ownerSavePractice?: (
            input: import("../../memory/owner-controls.js").SavePracticeInput,
          ) => Promise<import("../../memory/practices.js").PracticeUpsertResult>;
          ownerSetPracticeScope?: (
            id: string,
            scope: string,
          ) => Promise<import("../../memory/practices.js").PracticeUpsertResult>;
          resolveCaptureTaskType?: (
            sessionKey: string | undefined,
            text: string,
          ) => { slug: string; label: string } | null;
          // PLAN-64 Phase 1b: follow-up learning.
          practiceFollowUpDeps?: () => import("../../memory/practice-followup-turn.js").FollowUpTurnDeps;
        }
      | null
      | undefined;
    const store = m?.canonicalFacts?.() ?? null;
    const practicesOn = practicesEnabled(params.cfg.memory?.practices) && m?.ownerSavePractice;
    if (!store && !practicesOn) {
      return await resolvePracticeAttribution({ ...params, manager: m ?? null });
    }
    const lines: string[] = [];
    // PLAN-64 Phase 1b: follow-up learning, for the turn's own message (a
    // steered message is not "the owner's next message" after an answer).
    const practicesCfg = params.cfg.memory?.practices;
    const followDeps =
      practicesOn && (practiceFollowUpsEnabled(practicesCfg) || practiceOffersEnabled(practicesCfg))
        ? (m?.practiceFollowUpDeps?.() ?? null)
        : null;
    const followUps = followDeps ? await import("../../memory/practice-followup-turn.js") : null;
    const followTurn =
      followDeps && followUps
        ? await followUps.beginFollowUpTurn(followDeps, {
            cfg: params.cfg,
            sessionKey: params.sessionKey ?? run.sessionKey,
            sessionId: run.sessionId,
            userMessage: primary,
          })
        : null;
    let primaryCapture: Awaited<ReturnType<typeof runCorrectionCapture>> | null = null;
    // One pass (at most one model call) per owner message; the run's own
    // agent writes are reported once, with the first.
    let since = params.runStartedAt;
    for (const userMessage of userMessages) {
      if (abort.signal.aborted) {
        break;
      }
      const result = await runCorrectionCapture({
        cfg: params.cfg,
        sessionKey: params.sessionKey ?? run.sessionKey,
        sessionFile: run.sessionFile,
        activeProject: resolveActiveProjectName(run.workspaceDir),
        userMessage,
        assistantReply: params.replyText,
        senderIsOwner: run.senderIsOwner === true,
        isHeartbeat: params.isHeartbeat,
        chatType: params.chatType,
        runStartedAt: since,
        store,
        // No cron job id here: linking a main-session correction to the job
        // whose announcement it answers is a later phase (PLAN-64 §4.5).
        practices: practicesOn
          ? {
              save: (input) => m.ownerSavePractice!(input),
              store: m.practices?.() ?? null,
              setScope: m.ownerSetPracticeScope
                ? (id, scope) => m.ownerSetPracticeScope!(id, scope)
                : null,
              taskType:
                m.resolveCaptureTaskType?.(params.sessionKey ?? run.sessionKey, userMessage) ??
                null,
            }
          : null,
        followUp: userMessage === primary && !primaryCapture ? followTurn?.gapContext : null,
        pinAsOwner: m?.ownerPinFact ? (input) => m.ownerPinFact!(input) : null,
        llmCall: m?.correctionLlmCall?.() ?? null,
        signal: abort.signal,
      });
      since = Date.now();
      if (userMessage === primary && !primaryCapture) {
        primaryCapture = result;
      }
      if (result.line) {
        lines.push(result.line);
      }
    }
    if (followDeps && followUps && followTurn && !abort.signal.aborted) {
      if (followTurn.answerLine) {
        lines.push(followTurn.answerLine);
      }
      const finished = await followUps.finishFollowUpTurn(followDeps, followTurn, {
        cfg: params.cfg,
        sessionKey: params.sessionKey ?? run.sessionKey,
        sessionId: run.sessionId,
        sessionFile: run.sessionFile,
        userMessage: primary,
        replyText: params.replyText,
        chatType: params.chatType,
        activeProject: resolveActiveProjectName(run.workspaceDir),
        followUp: primaryCapture?.followUp ?? null,
        captured: primaryCapture?.practices ?? [],
      });
      if (finished.offerLine) {
        lines.push(finished.offerLine);
      }
    }
    if (lines.length > 0) {
      return lines.join("\n");
    }
    // PLAN-64 Phase 3: nothing else to say, so the reply may name the
    // practice its prompt carried. Not after an abort: a timed-out pass
    // sends no line, and a line that is not sent must not be counted.
    return abort.signal.aborted
      ? null
      : await resolvePracticeAttribution({ ...params, manager: m ?? null });
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string | null>((resolve) => {
    timer = setTimeout(() => {
      logVerbose("correction capture timed out; model call aborted, reply sent without a line");
      abort.abort(new Error("correction capture timed out"));
      resolve(null);
    }, CORRECTION_CAPTURE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    logVerbose(`correction capture failed: ${String(err)}`);
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    // An aborted pass unwinds in the background; its rejection must not
    // surface as unhandled.
    void work.catch(() => null);
  }
}
