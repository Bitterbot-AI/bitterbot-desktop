/**
 * PLAN-20 Phase 1: Pre-action interceptor contract.
 *
 * Each step the embedded agent proposes a tool call, the
 * runBeforeToolCallHook in pi-tools.before-tool-call.ts gets a chance to
 * inspect, modify, or block it. Until now the only consumers were plugin
 * hooks. PLAN-20 adds a deterministic skill-owned layer in front of those:
 * an interceptor reads a frozen snapshot of the agent's state (hormonal,
 * GCCRF, channel, recent turns), evaluates a fast `shouldActivate`
 * predicate, and if it fires returns a typed `Intervention` that either
 * rewrites the action, injects context, requires a prerequisite tool call,
 * or blocks the action entirely.
 *
 * This is the HASP (arXiv:2605.17734) contract translated to Bitterbot's
 * runtime, with one Bitterbot-specific addition: the `require_prereq`
 * intervention type. The runner inserts the prereq into the agent's tool
 * history before re-evaluating the original action.
 */

export type ChannelKind =
  | "internal"
  | "webchat"
  | "discord"
  | "telegram"
  | "whatsapp"
  | "signal"
  | "slack"
  | "googlechat"
  | "irc"
  | "voice"
  | "unknown";

export interface HormonalSnapshot {
  readonly dopamine: number;
  readonly cortisol: number;
  readonly oxytocin: number;
  readonly response: {
    readonly warmth: number;
    readonly energy: number;
    readonly focus: number;
    readonly playfulness: number;
    readonly verbosity: number;
    readonly curiosity: number;
    readonly assertiveness: number;
    readonly empathy: number;
  };
}

export interface GCCRFSnapshot {
  /** Prediction error (η) — surprise relative to known regions. */
  readonly predictionError: number;
  /** Learning progress (Δη) — improvement in prediction accuracy. */
  readonly learningProgress: number;
  /** Information-theoretic novelty (Iα). */
  readonly novelty: number;
  /** Empowerment (E·μ) — knowledge agency gated by uncertainty. */
  readonly empowerment: number;
  /** Strategic alignment (S) — goal-directed exploration. */
  readonly strategicAlignment: number;
  /**
   * Derived: change in agent's certainty since the last sample. Positive
   * means the agent feels more certain than it did a step ago. Useful for
   * `calibrate-claim-confidence` style interceptors.
   */
  readonly certaintyDelta: number;
}

export interface StepContext {
  readonly sessionKey: string;
  readonly agentId: string;
  readonly channel: ChannelKind;
  readonly turnNumber: number;
  readonly hormonal: HormonalSnapshot;
  readonly gccrf: GCCRFSnapshot;
  readonly recentTurns: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system" | "tool";
    /** Up to 80 chars, PII-redacted. Never the raw user message. */
    readonly preview: string;
  }>;
  readonly toolHistory: ReadonlyArray<{
    readonly tool: string;
    readonly success: boolean;
    readonly tsDelta: number;
  }>;
  /** Present when the candidate action is a `send_message`-shaped call. */
  readonly draftReply?: string;
  readonly activeTask?: {
    readonly id: string;
    readonly lastJournalReadAt: number;
  };
}

export interface CandidateAction {
  readonly toolName: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type Intervention =
  | {
      readonly type: "modify";
      readonly newParams: Record<string, unknown>;
      readonly reason: string;
    }
  | {
      readonly type: "inject";
      readonly contextText: string;
      readonly reason: string;
    }
  | {
      readonly type: "require_prereq";
      readonly tool: string;
      readonly params: Record<string, unknown>;
      readonly reason: string;
    }
  | {
      readonly type: "block";
      readonly reason: string;
      readonly userVisibleMessage?: string;
    }
  | { readonly type: "noop" };

export interface PreActionInterceptor {
  /** Globally unique, of the form `<skill>:<interceptor-name>`. */
  readonly id: string;
  /** SKILL.md name this interceptor belongs to. */
  readonly skill: string;
  /** Higher fires first. Default 0 if omitted at registration time. */
  readonly priority?: number;
  /** Hard cap per episode (session). Mirrors HASP `_MAX_FIRES`. */
  readonly maxFiresPerEpisode?: number;
  /** Cheap pre-filter applied before `shouldActivate`. Default: all tools. */
  readonly tools?: ReadonlyArray<string>;

  shouldActivate(ctx: StepContext, action: CandidateAction): boolean | Promise<boolean>;
  intervene(ctx: StepContext, action: CandidateAction): Intervention | Promise<Intervention>;
}

/** Trust origin gating — only `local` interceptors execute in v1. */
export type InterceptorOrigin = "builtin" | "local" | "mesh-pending";

export interface RegisteredInterceptor {
  readonly interceptor: PreActionInterceptor;
  readonly origin: InterceptorOrigin;
  readonly registeredAt: number;
}
