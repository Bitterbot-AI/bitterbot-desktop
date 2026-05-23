/**
 * PLAN-20: Late-bound accessors for the per-step state interceptors read.
 *
 * Interceptors live in `src/agents/skills/` and must not import the heavy
 * memory subsystem directly (avoids circular imports and keeps the
 * interceptor surface tree-shakable). Instead, the gateway registers
 * provider functions at startup and the runner consults them when building
 * a `StepContext`.
 *
 * Every provider is optional. If a provider is absent, the runner falls
 * back to a neutral default (e.g. resting hormonal homeostasis) so the
 * interceptor surface degrades gracefully when called outside the gateway
 * (tests, CLI, isolated workers).
 */

import type { ChannelKind, GCCRFSnapshot, HormonalSnapshot, StepContext } from "./interceptor.js";

export type ChannelResolver = (sessionKey: string) => ChannelKind;
export type HormonalSnapshotProvider = () => HormonalSnapshot | null;
export type GCCRFSnapshotProvider = () => GCCRFSnapshot | null;
export type RecentTurnsProvider = (sessionKey: string, limit: number) => StepContext["recentTurns"];
export type ToolHistoryProvider = (sessionKey: string, limit: number) => StepContext["toolHistory"];
export type DraftReplyProvider = (sessionKey: string) => string | undefined;
export type ActiveTaskProvider = (sessionKey: string) => StepContext["activeTask"];
export type TurnNumberProvider = (sessionKey: string) => number;

interface ProviderTable {
  channel?: ChannelResolver;
  hormonal?: HormonalSnapshotProvider;
  gccrf?: GCCRFSnapshotProvider;
  recentTurns?: RecentTurnsProvider;
  toolHistory?: ToolHistoryProvider;
  draftReply?: DraftReplyProvider;
  activeTask?: ActiveTaskProvider;
  turnNumber?: TurnNumberProvider;
}

const providers: ProviderTable = {};

export function setInterceptorContextProviders(next: Partial<ProviderTable>): void {
  Object.assign(providers, next);
}

export function clearInterceptorContextProviders(): void {
  for (const key of Object.keys(providers) as Array<keyof ProviderTable>) {
    delete providers[key];
  }
}

const NEUTRAL_HORMONAL: HormonalSnapshot = Object.freeze({
  dopamine: 0.1,
  cortisol: 0.02,
  oxytocin: 0.2,
  response: Object.freeze({
    warmth: 0.3,
    energy: 0.15,
    focus: 0.03,
    playfulness: 0.12,
    verbosity: 0.11,
    curiosity: 0.1,
    assertiveness: 0.05,
    empathy: 0.16,
  }),
});

const NEUTRAL_GCCRF: GCCRFSnapshot = Object.freeze({
  predictionError: 0,
  learningProgress: 0,
  novelty: 0,
  empowerment: 0.5,
  strategicAlignment: 0.5,
  certaintyDelta: 0,
});

export function resolveStepContext(args: {
  readonly sessionKey: string;
  readonly agentId: string;
}): StepContext {
  const channel = providers.channel?.(args.sessionKey) ?? "internal";
  const hormonal = providers.hormonal?.() ?? NEUTRAL_HORMONAL;
  const gccrf = providers.gccrf?.() ?? NEUTRAL_GCCRF;
  const recentTurns = providers.recentTurns?.(args.sessionKey, 6) ?? [];
  const toolHistory = providers.toolHistory?.(args.sessionKey, 8) ?? [];
  const draftReply = providers.draftReply?.(args.sessionKey);
  const activeTask = providers.activeTask?.(args.sessionKey);
  const turnNumber = providers.turnNumber?.(args.sessionKey) ?? 0;

  return Object.freeze({
    sessionKey: args.sessionKey,
    agentId: args.agentId,
    channel,
    turnNumber,
    hormonal,
    gccrf,
    recentTurns,
    toolHistory,
    draftReply,
    activeTask,
  }) satisfies StepContext;
}

/** Test helper — never used in production paths. */
export const __testing = {
  NEUTRAL_HORMONAL,
  NEUTRAL_GCCRF,
  providers,
};
