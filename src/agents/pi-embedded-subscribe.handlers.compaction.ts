import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { USAGE_FEATURES } from "../infra/usage-features.js";
import { recordUsage } from "../infra/usage-ledger.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

/** PLAN-50 Phase 5: context size at compaction start, per session, for the estimated row. */
const compactionTokensBefore = new WeakMap<object, { tokens: number; startedAt: number }>();

function estimateSessionTokens(messages: unknown): number {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let total = 0;
  for (const message of messages) {
    try {
      total += estimateTokens(message as Parameters<typeof estimateTokens>[0]);
    } catch {
      // best effort
    }
  }
  return total;
}

export function handleAutoCompactionStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.compactionInFlight = true;
  compactionTokensBefore.set(ctx.params.session as object, {
    tokens: estimateSessionTokens(ctx.params.session.messages),
    startedAt: Date.now(),
  });
  ctx.incrementCompactionCount();
  ctx.ensureCompactionPromise();
  ctx.log.debug(`embedded run compaction start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "start" },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "start" },
  });

  // Run before_compaction plugin hook (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_compaction")) {
    void hookRunner
      .runBeforeCompaction(
        {
          messageCount: ctx.params.session.messages?.length ?? 0,
        },
        {},
      )
      .catch((err) => {
        ctx.log.warn(`before_compaction hook failed: ${String(err)}`);
      });
  }
}

export function handleAutoCompactionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { willRetry?: unknown },
) {
  ctx.state.compactionInFlight = false;
  const willRetry = Boolean(evt.willRetry);
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    ctx.maybeResolveCompactionWait();
  }
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "end", willRetry },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "end", willRetry },
  });

  // PLAN-50 Phase 5: the summary call runs inside pi-agent-core with no usage callback, so it is
  // recorded as an estimate (context summarized in, summary text out) under agent/compaction.
  if (!willRetry && !(evt as { aborted?: unknown }).aborted) {
    const before = compactionTokensBefore.get(ctx.params.session as object);
    compactionTokensBefore.delete(ctx.params.session as object);
    const first = ctx.params.session.messages?.[0];
    const summaryTokens = first ? estimateSessionTokens([first]) : 0;
    if (before && before.tokens > 0) {
      recordUsage({
        kind: "chat",
        feature: USAGE_FEATURES.agentCompaction,
        provider: ctx.params.modelRef?.provider,
        model: ctx.params.modelRef?.model,
        agentId: ctx.params.agentId ?? parseAgentSessionKey(ctx.params.sessionKey)?.agentId,
        sessionKey: ctx.params.sessionKey,
        runId: ctx.params.runId,
        usage: { input: before.tokens, output: summaryTokens },
        costSource: "estimated",
        durationMs: Date.now() - before.startedAt,
        config: ctx.params.config,
      });
    }
  }

  // Run after_compaction plugin hook (fire-and-forget)
  if (!willRetry) {
    const hookRunnerEnd = getGlobalHookRunner();
    if (hookRunnerEnd?.hasHooks("after_compaction")) {
      void hookRunnerEnd
        .runAfterCompaction(
          {
            messageCount: ctx.params.session.messages?.length ?? 0,
            compactedCount: ctx.getCompactionCount(),
          },
          {},
        )
        .catch((err) => {
          ctx.log.warn(`after_compaction hook failed: ${String(err)}`);
        });
    }

    // Context was just discarded — flush unsynthesized scratch notes into the
    // working-memory state vector now instead of waiting for the dream tick.
    // Debounced + no-op when scratch is empty (fire-and-forget).
    void flushWorkingMemoryAfterCompaction(ctx);
  }
}

async function flushWorkingMemoryAfterCompaction(ctx: EmbeddedPiSubscribeContext): Promise<void> {
  try {
    const cfg = ctx.params.config;
    if (!cfg) {
      return;
    }
    const { resolveSessionAgentId } = await import("./agent-scope.js");
    const { getMemorySearchManager } = await import("../memory/index.js");
    const agentId = resolveSessionAgentId({ sessionKey: ctx.params.sessionKey, config: cfg });
    const { manager } = await getMemorySearchManager({ cfg, agentId });
    if (manager?.flushWorkingMemory) {
      await manager.flushWorkingMemory("compaction");
    }
  } catch (err) {
    ctx.log.debug(`working-memory flush after compaction failed: ${String(err)}`);
  }
}
