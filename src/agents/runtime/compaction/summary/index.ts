/**
 * PLAN-52 Phase 3: LLM-summary compaction, owned.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/compaction/compaction.js`, `core/compaction/utils.js` and
 * `core/messages.js`. Branch summarization is not ported. Differences from
 * the original are listed in the header of each file; the one that matters to
 * callers is that `compact` and `generateSummary` take an options object with
 * an injectable model call.
 *
 * Typical use:
 *
 *   const preparation = prepareCompaction(store.getBranch(), settings);
 *   if (preparation) {
 *     const result = await compact(preparation, { model, apiKey, signal });
 *     store.appendCompaction(
 *       result.summary,
 *       result.firstKeptEntryId,
 *       result.tokensBefore,
 *       result.details,
 *     );
 *   }
 */
export * from "./messages.js";
export * from "./tokens.js";
export * from "./serialize.js";
export * from "./cut.js";
export * from "./summarize.js";
