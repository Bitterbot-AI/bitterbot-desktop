/**
 * ARC-AGI-3 API types.
 *
 * Mirrors the OpenAPI spec at https://docs.arcprize.org/arc3v1.yaml plus
 * the documented FrameResponse shape. Keep this file in sync with the
 * upstream spec; everything else in the package depends on it.
 */

/** Action codes the server accepts. */
export type ArcActionId = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Special action: RESET (not numbered 1..7; carries no payload). */
export type ArcResetAction = "RESET";

/** Semantic mapping documented by Anthropic partner template. */
export const ACTION_LABELS: Record<ArcActionId, string> = {
  1: "up",
  2: "down",
  3: "left",
  4: "right",
  5: "contextual",
  6: "click-xy",
  7: "undo",
};

/** Game session lifecycle states. */
export type GameState = "NOT_STARTED" | "NOT_FINISHED" | "WIN" | "GAME_OVER";

/**
 * One frame from a `FrameResponse.frame` array. Row-major 64x64 grid of
 * integers in [0, 15] (4-bit palette index).
 */
export type GridFrame = number[][];

/**
 * The core observation an agent receives. `frame` is 1..N consecutive
 * 64x64 grids (multi-frame for animations); the LAST element is the
 * canonical "current state". `available_actions` is the valid-action
 * mask for the NEXT call. After GAME_OVER only RESET is accepted.
 */
export interface FrameResponse {
  game_id: string;
  guid: string;
  frame: GridFrame[];
  state: GameState;
  levels_completed: number;
  win_levels: number;
  action_input: {
    id: number;
    data: Record<string, unknown>;
  };
  available_actions: number[];
}

export interface GameSummary {
  game_id: string;
  title: string;
}

/** Optional reasoning blob attached to action commands. Max 16 KB JSON. */
export type ReasoningBlob = Record<string, unknown>;

export interface ResetCommandBody {
  game_id: string;
  card_id: string;
  guid?: string | null;
}

export interface SimpleActionBody {
  game_id: string;
  guid: string;
  reasoning?: ReasoningBlob;
}

export interface CoordinateActionBody extends SimpleActionBody {
  x: number;
  y: number;
}

export interface OpenScorecardBody {
  source_url?: string;
  tags?: string[];
  opaque?: Record<string, unknown>;
}

export interface OpenScorecardResponse {
  card_id: string;
}

export interface CloseScorecardBody {
  card_id: string;
}

/**
 * Per-level result inside a ScorecardSummary. Indexes align across
 * `level_scores`, `level_actions`, `level_baseline_actions`.
 */
export interface RunSummary {
  game_id: string;
  level_scores: number[];
  level_actions: number[];
  level_baseline_actions: number[];
  total_score?: number;
  win_levels_reached?: number;
}

export interface ScorecardSummary {
  card_id: string;
  source_url?: string;
  tags: string[];
  opaque: Record<string, unknown>;
  runs: RunSummary[];
  score?: number;
  scorecard_url?: string;
  opened_at: string;
  closed_at?: string;
}

/**
 * The bridge between the typed action enum and the REST endpoint path.
 * Resets are special: their command path is `/api/cmd/RESET`, not
 * `/api/cmd/ACTION{N}`.
 */
export type ArcAction =
  | { kind: "reset" }
  | { kind: "simple"; action: ArcActionId; reasoning?: ReasoningBlob }
  | { kind: "coordinate"; x: number; y: number; reasoning?: ReasoningBlob };

/** Construct a `simple` action. */
export function simpleAction(action: ArcActionId, reasoning?: ReasoningBlob): ArcAction {
  if (action === 6) {
    throw new Error("ACTION6 requires (x, y) — use coordinateAction()");
  }
  return { kind: "simple", action, reasoning };
}

/** Construct an ACTION6 (click at x,y). */
export function coordinateAction(x: number, y: number, reasoning?: ReasoningBlob): ArcAction {
  if (!Number.isInteger(x) || x < 0 || x > 63) {
    throw new Error(`ACTION6 x out of range [0,63]: ${x}`);
  }
  if (!Number.isInteger(y) || y < 0 || y > 63) {
    throw new Error(`ACTION6 y out of range [0,63]: ${y}`);
  }
  return { kind: "coordinate", x, y, reasoning };
}

export function resetAction(): ArcAction {
  return { kind: "reset" };
}
