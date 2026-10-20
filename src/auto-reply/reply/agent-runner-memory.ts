import crypto from "node:crypto";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { resolveActiveProjectName } from "../../agents/canonical-facts-block.js";
import { runEmbeddedPiAgent } from "../../agents/embedded.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import type { BitterbotConfig } from "../../config/config.js";
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

/**
 * PLAN-55 Phase 1: the per-turn correction capture, on run completion of a
 * first-party owner turn (the reply runner, the followup runner, and the
 * turns a steered message joined). Returns the one-line "Memory updated"
 * confirmation to append to the reply, or null. Cheap gates run before the
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
    return null;
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
        }
      | null
      | undefined;
    const store = m?.canonicalFacts?.() ?? null;
    if (!store) {
      return null;
    }
    const lines: string[] = [];
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
        pinAsOwner: m?.ownerPinFact ? (input) => m.ownerPinFact!(input) : null,
        llmCall: m?.correctionLlmCall?.() ?? null,
        signal: abort.signal,
      });
      since = Date.now();
      if (result.line) {
        lines.push(result.line);
      }
    }
    return lines.length > 0 ? lines.join("\n") : null;
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
