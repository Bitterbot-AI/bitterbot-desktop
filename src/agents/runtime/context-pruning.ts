/**
 * Opt-in context pruning ("microcompact"-style): pure pruning of old tool
 * results in the in-memory context of one request. It does not rewrite
 * session history on disk. The pi extension that calls it is
 * `engines/pi/extensions/context-pruning.ts`.
 */

export { pruneContextMessages } from "./context-pruning/pruner.js";
export type {
  ContextPruningConfig,
  ContextPruningToolMatch,
  EffectiveContextPruningSettings,
} from "./context-pruning/settings.js";
export {
  computeEffectiveSettings,
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
} from "./context-pruning/settings.js";
