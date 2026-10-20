/**
 * PLAN-52A in-run context budget: the part of the mid-turn guard that
 * actually reaches the model.
 *
 * pi-agent-core's loop works on a snapshot of the messages taken when the run
 * starts. The original mid-turn guard assigned `agent.state.messages` from the
 * tool-end handler, which changes the session state but never the context of
 * the run in flight, so a long tool loop kept sending every tool output on
 * every call (sessions reached 133k to 190k prompt tokens with the guard
 * "armed" at 80%). The loop does call `transformContext(messages)` before
 * every model call; this module is that hook.
 *
 * Per model call:
 * 1. Re-apply every tool-output stub recorded on this branch.
 * 2. If the context is over the trigger, stub more old tool outputs (oldest
 *    first, newest two and small ones exempt) toward the stub target, record
 *    them (`bitterbot.offload-prune`), and apply.
 * 3. If still over the compression target, fall back to progressive
 *    compression (deterministic truncation) for this call only.
 *
 * The transcript is never modified; only the context sent to the model is.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  compressOldMessages,
  type ProgressiveCompressionConfig,
} from "../../progressive-compression.js";
import { applyStubsToMessages, planMessageStubs, type ToolOutputStub } from "./offload-stubs.js";

export type InRunBudgetSettings = {
  /** Stub tool outputs (PLAN-52A T3). Default true. */
  stubsEnabled: boolean;
  /** Fraction of the window above which the guard acts. Default 0.80. */
  triggerFraction: number;
  /** Stub target as a fraction of the window. Default 0.50. */
  stubTargetFraction: number;
  /** Tool outputs under this estimate are never stubbed. Default 1000. */
  stubMinTokens: number;
  /** Most recent tool outputs never stubbed. Default 2. */
  spareRecent: number;
  /** Progressive compression fallback. Default true. */
  compressionEnabled: boolean;
  /** Compression target as a fraction of the window. Default 0.65. */
  compressionTargetFraction: number;
  compression?: ProgressiveCompressionConfig;
  /** Skip the token estimate below this many chars of message text. Default 80000. */
  minChars: number;
};

export const DEFAULT_IN_RUN_BUDGET: InRunBudgetSettings = {
  stubsEnabled: true,
  triggerFraction: 0.8,
  stubTargetFraction: 0.5,
  stubMinTokens: 1_000,
  spareRecent: 2,
  compressionEnabled: true,
  compressionTargetFraction: 0.65,
  minChars: 80_000,
};

export type InRunBudgetEvent = {
  tokensBefore: number;
  tokensAfter: number;
  newStubs: number;
  recordedStubs: number;
  compressed: boolean;
};

export type InRunBudgetDeps = {
  contextWindowTokens: number;
  /** Tokens the estimate cannot see (system prompt, tool definitions). */
  fixedTokens?: number;
  estimate: (message: AgentMessage) => number;
  settings?: Partial<InRunBudgetSettings>;
  /** Stubs already recorded on this branch; this map is updated in place. */
  recorded: Map<string, ToolOutputStub>;
  /** Persist newly planned stubs (best effort; a throw is swallowed). */
  persist: (stubs: ToolOutputStub[]) => void;
  onApplied?: (event: InRunBudgetEvent) => void;
};

function messageChars(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text === "string") {
      total += text.length;
    }
  }
  return total;
}

/** Build the per-call transform. Pure apart from `deps.persist` and the `recorded` map. */
export function createInRunBudgetTransform(
  deps: InRunBudgetDeps,
): (messages: AgentMessage[]) => AgentMessage[] {
  const s: InRunBudgetSettings = { ...DEFAULT_IN_RUN_BUDGET, ...deps.settings };
  const fixed = Math.max(0, deps.fixedTokens ?? 0);
  const sum = (ms: readonly AgentMessage[]) => {
    let total = 0;
    for (const m of ms) {
      total += deps.estimate(m);
    }
    return total;
  };

  return (messages: AgentMessage[]): AgentMessage[] => {
    if (!Array.isArray(messages) || messages.length === 0 || deps.contextWindowTokens <= 0) {
      return messages;
    }
    // 1. Stubs recorded earlier (this run or previous turns) always hold.
    let working: AgentMessage[] = messages;
    if (s.stubsEnabled && deps.recorded.size > 0) {
      const res = applyStubsToMessages(messages, deps.recorded);
      if (res.applied > 0) {
        working = res.messages;
      }
    }

    let chars = 0;
    for (const m of working) {
      chars += messageChars(m);
    }
    if (chars < s.minChars) {
      return working;
    }
    const tokensBefore = fixed + sum(working);
    const trigger = Math.floor(deps.contextWindowTokens * s.triggerFraction);
    if (tokensBefore < trigger) {
      return working;
    }

    // 2. New stubs.
    let newStubs: ToolOutputStub[] = [];
    let tokens = tokensBefore;
    if (s.stubsEnabled) {
      newStubs = planMessageStubs({
        messages: working,
        estimate: deps.estimate,
        totalTokens: tokensBefore,
        targetTokens: Math.floor(deps.contextWindowTokens * s.stubTargetFraction),
        settings: { minTokens: s.stubMinTokens, spareRecent: s.spareRecent },
      });
      if (newStubs.length > 0) {
        for (const stub of newStubs) {
          deps.recorded.set(stub.toolCallId, stub);
        }
        try {
          deps.persist(newStubs);
        } catch {
          // The stubs still hold for this run through `recorded`.
        }
        working = applyStubsToMessages(working, deps.recorded).messages;
        tokens = fixed + sum(working);
      }
    }

    // 3. Fallback: deterministic truncation for this call.
    let compressed = false;
    const compressionTarget = Math.floor(deps.contextWindowTokens * s.compressionTargetFraction);
    if (s.compressionEnabled && tokens >= trigger) {
      const result = compressOldMessages([...working], Math.max(0, compressionTarget - fixed), {
        enabled: true,
        ...s.compression,
      });
      if (result.totalCompressed > 0 && result.tokensAfter < result.tokensBefore) {
        working = result.messages;
        tokens = fixed + result.tokensAfter;
        compressed = true;
      }
    }

    if (newStubs.length > 0 || compressed) {
      deps.onApplied?.({
        tokensBefore,
        tokensAfter: tokens,
        newStubs: newStubs.length,
        recordedStubs: deps.recorded.size,
        compressed,
      });
    }
    return working;
  };
}

type AgentLike = {
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
};

/**
 * Chain the transform after whatever `transformContext` the agent already has
 * (pi's extension runner). Must run before `prompt()`: the loop snapshots the
 * hook when a run starts.
 */
export function installInRunBudget(agent: AgentLike, deps: InRunBudgetDeps): void {
  const previous = agent.transformContext;
  const transform = createInRunBudgetTransform(deps);
  agent.transformContext = async (messages, signal) => {
    const base = previous ? await previous(messages, signal) : messages;
    return transform(base);
  };
}
