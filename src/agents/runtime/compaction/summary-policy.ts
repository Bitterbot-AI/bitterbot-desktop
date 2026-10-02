/**
 * PLAN-52 6.4: the "summary" compaction policy, pi's behaviour: an LLM
 * summary of the history before a token-based cut point (`./summary`), with
 * the model call routed through the session's stream function instead of a
 * direct provider call.
 */

import type { StreamFn } from "../loop/index.js";
import type { CompactionPolicy } from "./policy.js";
import { compact, type CompleteFn, prepareCompaction, shouldCompact } from "./summary/index.js";

/** A non-streaming model call made through a stream function. */
export function completeThrough(streamFn: StreamFn): CompleteFn {
  return async (model, context, options) => {
    const stream = await streamFn(model, context, options);
    return stream.result();
  };
}

export function createSummaryCompactionPolicy(): CompactionPolicy {
  return {
    name: "summary",
    shouldCompact: ({ contextTokens, contextWindow, settings }) =>
      shouldCompact(contextTokens, contextWindow, settings),
    async compact(request) {
      const preparation = prepareCompaction(request.pathEntries, request.settings);
      if (!preparation) {
        return undefined;
      }
      return compact(preparation, {
        model: request.model,
        apiKey: request.apiKey,
        headers: request.headers,
        customInstructions: request.customInstructions,
        signal: request.signal,
        thinkingLevel: request.thinkingLevel,
        complete: completeThrough(request.streamFn),
      });
    },
  };
}
