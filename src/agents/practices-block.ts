/**
 * PLAN-64 Phase 1: resolve the Standing Practices block for the system
 * prompt.
 *
 * Practices are the owner's standing instructions about how to do a kind of
 * task. Only `active` practices whose scope matches the turn are rendered,
 * most specific scope first (job, task, project, person, global), capped at
 * PRACTICES_BLOCK_MAX practices and PRACTICES_BLOCK_BUDGET_TOKENS.
 *
 * Unlike the canonical facts block this one depends on the turn (its task
 * type), so it is rendered in the volatile half of the prompt, below the
 * cache boundary.
 *
 * Who gets it: the owner's own first-party turns (the trust rules of the
 * correction capture: no guests, groups, subagents, A2A, heartbeats), plus
 * one exception, a cron job's own `cron:<jobId>` session, which gets that
 * job's `job:<jobId>` practices and nothing else.
 *
 * The turn's task type is resolved here, before the block is built, by word
 * overlap against the stored task types (no model call; task-types.ts). The
 * same call counts the turn as an occurrence of its type.
 *
 * "Applied" is prompt inclusion: every practice rendered gets an `applied`
 * event and its `applied_count` bumped, once per run. Nothing here knows
 * whether the answer followed it.
 */

import type { BitterbotConfig } from "../config/config.js";
import { practicesEnabled } from "../config/feature-switches.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { stripNonProse } from "../memory/correction-capture.js";
import type { Practice } from "../memory/practices.js";
import { classifySessionKeyTrust } from "../memory/session-trust.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { resolveActiveProjectName } from "./canonical-facts-block.js";

const log = createSubsystemLogger("practices-block");

export const PRACTICES_BLOCK_MAX = 8;
export const PRACTICES_BLOCK_BUDGET_TOKENS = 400;
/** The budget in characters (4 per token, the estimate the facts ledger uses). */
const PRACTICES_BLOCK_BUDGET_CHARS = PRACTICES_BLOCK_BUDGET_TOKENS * 4;

export const PRACTICES_BLOCK_HEADER = [
  "## Standing Practices",
  "How the owner wants these kinds of task done. Follow each one that applies",
  "to this turn. Never announce this section.",
];

/**
 * The cron job a session key belongs to: `cron:<jobId>`,
 * `agent:<id>:cron:<jobId>` or either with a `:run:<runId>` suffix. Null for
 * every other session.
 */
export function cronJobIdFromSessionKey(sessionKey: string | undefined | null): string | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }
  const rest = parseAgentSessionKey(raw)?.rest ?? raw;
  const m = /^cron:([^:]+)(?::run:[^:]+)?$/i.exec(rest);
  return m?.[1] ?? null;
}

/** The terse tag in front of a practice that is not global. */
function scopeTag(practice: Practice, taskLabels: ReadonlyMap<string, string>): string {
  const scope = practice.scope;
  if (scope === "global") {
    return "";
  }
  const name = scope.slice(scope.indexOf(":") + 1);
  if (scope.startsWith("task:")) {
    return `[${taskLabels.get(name)?.trim() || name.replace(/-/g, " ")}] `;
  }
  if (scope.startsWith("job:")) {
    return "[this job] ";
  }
  if (scope.startsWith("project:")) {
    return `[project ${name}] `;
  }
  return `[for ${name.replace(/-/g, " ")}] `;
}

/**
 * Render the block from practices already filtered and ordered (most
 * specific scope first). Stops at the practice cap or when the next line
 * would exceed the budget; returns the practices actually rendered so the
 * caller counts those and no others.
 */
export function renderPracticesBlock(
  practices: Practice[],
  opts: { taskLabels?: ReadonlyMap<string, string> } = {},
): { block: string | undefined; rendered: Practice[] } {
  const taskLabels = opts.taskLabels ?? new Map<string, string>();
  const lines: string[] = [];
  const rendered: Practice[] = [];
  let chars = PRACTICES_BLOCK_HEADER.join("\n").length;
  for (const practice of practices) {
    if (rendered.length >= PRACTICES_BLOCK_MAX) {
      break;
    }
    const line = `- ${scopeTag(practice, taskLabels)}${practice.statement.replace(/\s+/g, " ").trim()}`;
    if (chars + line.length + 1 > PRACTICES_BLOCK_BUDGET_CHARS) {
      // Most specific first: what does not fit is the least specific.
      break;
    }
    chars += line.length + 1;
    lines.push(line);
    rendered.push(practice);
  }
  if (rendered.length === 0) {
    return { block: undefined, rendered };
  }
  return { block: [...PRACTICES_BLOCK_HEADER, ...lines].join("\n"), rendered };
}

export type PracticesTurn = {
  config?: BitterbotConfig;
  sessionKey?: string;
  promptMode?: "full" | "minimal" | "none";
  senderIsOwner?: boolean;
  isHeartbeat?: boolean;
  /** A guest or a remote task drives this turn: never rendered. */
  guestTurn?: boolean;
};

/**
 * Which practices this turn may see: `owner` (every scope that matches),
 * `job` (the cron job's own practices only) or null (none).
 */
export function resolvePracticesTurnPolicy(
  turn: PracticesTurn,
): { kind: "owner" } | { kind: "job"; cronJobId: string } | null {
  if (!practicesEnabled(turn.config?.memory?.practices)) {
    return null;
  }
  if (turn.promptMode === "none" || turn.guestTurn || turn.isHeartbeat) {
    return null;
  }
  const cronJobId = cronJobIdFromSessionKey(turn.sessionKey);
  if (cronJobId) {
    return { kind: "job", cronJobId };
  }
  if (
    turn.senderIsOwner !== true ||
    !turn.sessionKey ||
    classifySessionKeyTrust(turn.sessionKey) !== "first_party"
  ) {
    return null;
  }
  return { kind: "owner" };
}

/** The slice of the memory manager this block uses (the real one, or a test double). */
export type PracticesBlockManager = {
  practices: () => {
    listVisible: (
      ctx: { activeProject?: string | null; taskSlug?: string | null; cronJobId?: string | null },
      opts?: { kinds?: ReadonlySet<string> },
    ) => Practice[];
    recordApplied: (
      ids: string[],
      opts?: { turnKey?: string; sessionRef?: string | null },
    ) => number;
  };
  observeOwnerTurnTaskType?: (params: {
    text: string;
    sessionKey?: string;
    turnKey?: string;
  }) => { slug: string; label: string } | null;
};

const JOB_ONLY: ReadonlySet<string> = new Set(["job"]);

/** The synchronous core: type the turn, select, render, count. */
export function buildPracticesBlock(
  manager: PracticesBlockManager,
  params: PracticesTurn & {
    workspaceDir?: string;
    /** The owner's message for this turn (envelope and context blocks are stripped here). */
    prompt?: string;
    /** The run id: a retried attempt of one run is typed and counted once. */
    runId?: string;
    sessionFile?: string;
  },
): string | undefined {
  const policy = resolvePracticesTurnPolicy(params);
  if (!policy) {
    return undefined;
  }
  const store = manager.practices();
  let visible: Practice[];
  const taskLabels = new Map<string, string>();
  if (policy.kind === "job") {
    visible = store.listVisible({ cronJobId: policy.cronJobId }, { kinds: JOB_ONLY });
  } else {
    // Resolved before the block is built: one table read and a word-set
    // comparison per stored exemplar, no model call.
    const prose = params.prompt ? stripNonProse(params.prompt) : "";
    const task = prose.trim()
      ? (manager.observeOwnerTurnTaskType?.({
          text: prose,
          sessionKey: params.sessionKey,
          turnKey: params.runId,
        }) ?? null)
      : null;
    if (task) {
      taskLabels.set(task.slug, task.label);
    }
    visible = store.listVisible({
      activeProject: resolveActiveProjectName(params.workspaceDir),
      taskSlug: task?.slug ?? null,
    });
  }
  const { block, rendered } = renderPracticesBlock(visible, { taskLabels });
  if (rendered.length > 0) {
    // Prompt inclusion, not proof the answer followed the practice.
    store.recordApplied(
      rendered.map((p) => p.id),
      {
        turnKey: params.runId,
        sessionRef: params.sessionFile ? `session:${params.sessionFile}` : null,
      },
    );
  }
  return block;
}

export async function resolvePracticesBlock(
  params: PracticesTurn & {
    agentId: string;
    workspaceDir?: string;
    prompt?: string;
    runId?: string;
    sessionFile?: string;
  },
): Promise<string | undefined> {
  // Decided before the memory manager is touched: a turn that gets no
  // practices costs nothing.
  if (!resolvePracticesTurnPolicy(params)) {
    return undefined;
  }
  try {
    const { MemoryIndexManager } = await import("../memory/manager.js");
    const manager = await MemoryIndexManager.get({
      cfg: params.config ?? {},
      agentId: params.agentId,
      purpose: "status",
    });
    if (!manager) {
      return undefined;
    }
    return buildPracticesBlock(manager, params);
  } catch (err) {
    log.debug(`practices block unavailable: ${String(err)}`);
    return undefined;
  }
}
