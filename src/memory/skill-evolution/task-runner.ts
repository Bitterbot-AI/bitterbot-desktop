/**
 * PLAN-42 Phase 4 (tasks mode) + PLAN-44 Phase 2 (D-3, D-4): the
 * real-rollout runner.
 *
 * The paper validates a candidate skill by ACTUALLY RUNNING the agent on
 * held-out tasks with the candidate installed and comparing outcomes. Two
 * arms are built here:
 *
 *   - RUNTIME PATHWAY (PLAN-44 D-3, the gate's arm): the candidate is
 *     presented exactly as the runtime presents skills — an
 *     `<available_skills>` index entry (name, description, location) plus
 *     the runtime's own "read at most one SKILL.md" instruction — and the
 *     SKILL.md body is written into a per-trial scratch WORKSPACE that the
 *     validation session runs in (workspace-scoped tools, PLAN-44 D-4).
 *     The agent must trigger on the description and read the file; the
 *     journal records whether it did (`skillRead`), which feeds the gate's
 *     trigger-precision rule. Audit finding: the old arm injected the full
 *     body while the runtime shows a description index, so the gate
 *     validated a pathway the runtime never uses.
 *   - FULL INJECTION (kept for the PLAN-43 attestation sweep, which
 *     re-scores peer skills as a ceiling check): the skill body rides in
 *     the prompt itself.
 *
 * Dependency-injected executor: `AgentTurnFn` runs one real agent turn.
 * The gateway-RPC adapter is the production executor; tests inject a
 * deterministic fake.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { EventJournal } from "../../infra/event-journal.js";
import type { CorpusTask } from "./task-corpus.js";
import type { TaskRunnerFn, TaskVariant, TrialContext, TrialResult } from "./validate-tasks.js";
import { resolveWikiDir, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("skill-evolution/task-runner");

export const TRIALS_SUBDIR = ".trials";

/**
 * PLAN-44 Phase 2 (adversarial H1): the gateway honours a `workspaceDir`
 * only if THIS process registered it for a trial. A gateway client that
 * mints a validation-shaped session key cannot point a run at "/" or at
 * ~/.bitterbot. Consumed once per trial.
 */
const registeredTrialWorkspaces = new Set<string>();

export function registerTrialWorkspace(dir: string): void {
  registeredTrialWorkspaces.add(path.resolve(dir));
}

/** True (and forgets the dir) when the dir was registered by the runner. */
export function consumeTrialWorkspace(dir: string | undefined): boolean {
  if (!dir) {
    return false;
  }
  return registeredTrialWorkspaces.delete(path.resolve(dir));
}

/** What one real agent turn reports back. Plain string is accepted for compatibility. */
export interface AgentTurnOutcome {
  text: string;
  /** The run's id in the event journal (the gateway idempotency key). */
  runId?: string;
  usage?: { input?: number; output?: number };
}

export interface AgentTurnOptions {
  timeoutMs?: number;
  /** PLAN-44 D-4: per-trial scratch workspace the validation session runs in. */
  workspaceDir?: string;
}

/** Runs one real agent turn on a throwaway session; returns the final answer. */
export type AgentTurnFn = (
  prompt: string,
  opts?: AgentTurnOptions,
) => Promise<string | AgentTurnOutcome>;

function normalizeOutcome(r: string | AgentTurnOutcome): AgentTurnOutcome {
  return typeof r === "string" ? { text: r } : r;
}

// ---------------------------------------------------------------------------
// Full injection (attestation ceiling check)
// ---------------------------------------------------------------------------

const SKILL_INJECTION_HEADER =
  "You have access to the following skill. Read it and apply its guidance if it is relevant to the task:";

export function composeTaskPrompt(task: CorpusTask, skillBody: string | null): string {
  if (!skillBody) {
    return task.prompt;
  }
  return `${SKILL_INJECTION_HEADER}\n\n--- BEGIN SKILL ---\n${skillBody}\n--- END SKILL ---\n\n${task.prompt}`;
}

/**
 * Paired runner with FULL injection: the two arms differ only by the
 * skill text in the prompt. Used by the attestation sweep; the validation
 * gate uses the runtime pathway below.
 */
export function makeInjectedSkillRunner(
  agentTurn: AgentTurnFn,
  candidateContent: string,
  incumbentContent: string | null,
): TaskRunnerFn {
  return async (task: CorpusTask, variant: TaskVariant): Promise<TrialResult> => {
    const body = variant === "candidate" ? candidateContent : incumbentContent;
    const prompt = composeTaskPrompt(task, body);
    const r = normalizeOutcome(
      await agentTurn(prompt, task.timeoutMs ? { timeoutMs: task.timeoutMs } : {}),
    );
    return { answer: r.text, ...(r.usage ? { usage: r.usage } : {}) };
  };
}

// ---------------------------------------------------------------------------
// Runtime pathway (the gate's arm)
// ---------------------------------------------------------------------------

/** Pull `description:` (and `name:`) out of SKILL.md YAML frontmatter. */
export function parseSkillFrontmatter(content: string): {
  name: string | null;
  description: string;
} {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const block = m?.[1] ?? "";
  const get = (key: string) => {
    const line = block.split("\n").find((l) => new RegExp(`^${key}\\s*:`).test(l));
    if (!line) {
      return null;
    }
    return line
      .slice(line.indexOf(":") + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  };
  return { name: get("name"), description: get("description") ?? "" };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The runtime's skill presentation, reproduced for one trial: the index
 * entry plus the mandatory selection instruction (system-prompt.ts
 * buildSkillsSection / pi-coding-agent formatSkillsForPrompt), followed by
 * the task. The body is NOT here — it is on disk at `location`.
 */
export function composeRuntimePathwayPrompt(
  task: CorpusTask,
  skill: { name: string; description: string; location: string } | null,
): string {
  if (!skill) {
    return task.prompt;
  }
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
    "  <skill>",
    `    <name>${escapeXml(skill.name)}</name>`,
    `    <description>${escapeXml(skill.description)}</description>`,
    `    <location>${escapeXml(skill.location)}</location>`,
    "  </skill>",
    "</available_skills>",
    "",
    "Skills (mandatory): before replying, scan the <available_skills> <description> entries.",
    "- If exactly one skill clearly applies: read its SKILL.md at <location> with the read tool, then follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "The skill listed above supersedes any same-named skill elsewhere in your context.",
    "",
    task.prompt,
  ].join("\n");
}

/**
 * Did the run read the skill file? Journal-derived, never self-reported:
 * a `read` tool start whose path resolves to the location (relative paths
 * resolve against the workspace — the runtime chdirs there), or an `exec`
 * whose command names it (adversarial H6).
 */
export function detectSkillRead(
  journal: EventJournal,
  runId: string,
  location: string,
  workspaceDir?: string,
): boolean | null {
  try {
    // Unobservable only when the run left NO journal rows at all; a run
    // that answered without any tool call did not read the skill.
    if (journal.queryMeta({ runId, limit: 1 }).length === 0) {
      return null;
    }
    const rows = journal.query({ runId, streams: ["tool"], limit: 2_000 });
    const target = path.resolve(location);
    const relative = workspaceDir ? path.relative(workspaceDir, target) : null;
    return rows.some((row) => {
      if (row.data.phase !== "start") {
        return false;
      }
      const args = (row.data.args ?? {}) as Record<string, unknown>;
      if (row.data.name === "read") {
        const p = [args.path, args.file_path, args.filePath].find((v) => typeof v === "string") as
          | string
          | undefined;
        if (!p) {
          return false;
        }
        const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspaceDir ?? "", p);
        return resolved === target;
      }
      if (row.data.name === "exec" && typeof args.command === "string") {
        return (
          args.command.includes(target) || (relative !== null && args.command.includes(relative))
        );
      }
      return false;
    });
  } catch (err) {
    log.debug(`skill-read detection failed for ${runId}: ${String(err)}`);
    return null;
  }
}

export interface RuntimePathwayDeps {
  agentTurn: AgentTurnFn;
  /** Set to observe reads; without it `skillRead` is null (gate treats as unobservable). */
  journal?: EventJournal | null;
  candidate: { name: string; content: string };
  /** Live skill for a patch proposal; null for a create (the incumbent arm runs with no skill). */
  incumbent: { name: string; content: string } | null;
  /** Unique per proposal; trial dirs live under <wiki>/.trials/<proposalId>/. */
  proposalId: string;
  storeOpts?: ImpactTrailOptions;
  /** Keep trial dirs after scoring (debugging). Default false. */
  keepTrialDirs?: boolean;
  /**
   * Put the index entry in the user message as well (legacy / tests).
   * Default false: the validation session's SYSTEM prompt carries the real
   * skills index (the scratch workspace's `skills/` root plus the node's
   * live skills), exactly like the runtime (adversarial H5).
   */
  indexInPrompt?: boolean;
}

/** Write `task.files` under the workspace; refuses anything outside it. */
export async function writeTaskFiles(workspaceDir: string, task: CorpusTask): Promise<void> {
  const root = path.resolve(workspaceDir);
  for (const [rel, content] of Object.entries(task.files ?? {})) {
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`task ${task.id}: file path escapes the workspace: ${rel}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
  }
}

export function trialsRoot(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), TRIALS_SUBDIR);
}

/**
 * Paired runner via the RUNTIME PATHWAY. Every trial gets a fresh scratch
 * workspace containing `skills/<name>/SKILL.md` for its arm; the prompt
 * carries only the index entry; the session runs workspace-scoped (D-4);
 * the dir is removed after the turn.
 */
export function makeRuntimePathwayRunner(deps: RuntimePathwayDeps): TaskRunnerFn {
  const safeProposal = deps.proposalId.replace(/[^a-z0-9._-]/gi, "_").slice(0, 64);
  return async (
    task: CorpusTask,
    variant: TaskVariant,
    ctx: TrialContext,
  ): Promise<TrialResult> => {
    const arm = variant === "candidate" ? deps.candidate : deps.incumbent;
    const trialDir = path.join(
      trialsRoot(deps.storeOpts),
      safeProposal,
      task.id.replace(/[^a-z0-9._-]/gi, "_").slice(0, 64),
      `${variant}-${ctx.trialIndex}`,
    );
    const workspaceDir = path.join(trialDir, "workspace");
    await fs.rm(trialDir, { recursive: true, force: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    // PLAN-45 Phase 2.1: the task's generated files land in the workspace
    // before the turn (paths were validated at parse time; re-checked here).
    await writeTaskFiles(workspaceDir, task);
    let skill: { name: string; description: string; location: string } | null = null;
    if (arm) {
      const fm = parseSkillFrontmatter(arm.content);
      const location = path.join(workspaceDir, "skills", arm.name, "SKILL.md");
      await fs.mkdir(path.dirname(location), { recursive: true });
      await fs.writeFile(location, arm.content, "utf-8");
      skill = { name: fm.name ?? arm.name, description: fm.description, location };
    }
    try {
      const prompt = deps.indexInPrompt ? composeRuntimePathwayPrompt(task, skill) : task.prompt;
      registerTrialWorkspace(workspaceDir);
      const r = normalizeOutcome(
        await deps.agentTurn(prompt, {
          workspaceDir,
          ...(task.timeoutMs ? { timeoutMs: task.timeoutMs } : {}),
        }),
      );
      consumeTrialWorkspace(workspaceDir); // in case the executor never consumed it
      const skillRead =
        skill && deps.journal && r.runId
          ? detectSkillRead(deps.journal, r.runId, skill.location, workspaceDir)
          : null;
      return {
        answer: r.text,
        skillRead,
        ...(r.usage ? { usage: r.usage } : {}),
      };
    } finally {
      if (!deps.keepTrialDirs) {
        await fs.rm(trialDir, { recursive: true, force: true }).catch(() => undefined);
        // Prune the now-empty <proposal>/<task> parents (best-effort).
        for (const dir of [path.dirname(trialDir), path.dirname(path.dirname(trialDir))]) {
          await fs.rmdir(dir).catch(() => undefined);
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Production executor: the gateway `agent` RPC
// ---------------------------------------------------------------------------

/** Shape of the gateway `agent` RPC response (subset we consume). */
interface AgentRpcResponse {
  status?: string;
  runId?: string;
  result?: {
    payloads?: Array<{ text?: string }>;
    meta?: { agentMeta?: { usage?: { input?: number; output?: number } } };
  };
}

export interface GatewayAgentTurnDeps {
  callGateway: (args: {
    method: string;
    params: unknown;
    expectFinal?: boolean;
    timeoutMs?: number;
  }) => Promise<unknown>;
  agentId: string;
  channel: string;
  makeSessionKey: () => string;
  makeIdempotencyKey: () => string;
  defaultTimeoutMs?: number;
}

/**
 * Production executor: one real agent turn via the gateway `agent` RPC on a
 * throwaway, non-delivering skill-evolve validation session (restricted
 * tool policy + scratch workspace via D-4). The idempotency key doubles as
 * the journal runId, so the caller can look the run up.
 */
export function makeGatewayAgentTurn(deps: GatewayAgentTurnDeps): AgentTurnFn {
  return async (prompt, opts) => {
    const timeoutMs = opts?.timeoutMs ?? deps.defaultTimeoutMs ?? 120_000;
    const idempotencyKey = deps.makeIdempotencyKey();
    const resp = (await deps.callGateway({
      method: "agent",
      params: {
        message: prompt,
        agentId: deps.agentId,
        sessionKey: deps.makeSessionKey(),
        deliver: false,
        channel: deps.channel,
        timeout: Math.ceil(timeoutMs / 1000),
        idempotencyKey,
        ...(opts?.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
      },
      expectFinal: true,
      timeoutMs: timeoutMs + 5_000,
    })) as AgentRpcResponse;
    if (resp?.status !== "ok") {
      throw new Error(`agent turn returned status "${resp?.status ?? "none"}"`);
    }
    const usage = resp.result?.meta?.agentMeta?.usage;
    return {
      text: (resp.result?.payloads ?? [])
        .map((p) => p.text ?? "")
        .join("\n")
        .trim(),
      runId: resp.runId ?? idempotencyKey,
      ...(usage ? { usage: { input: usage.input, output: usage.output } } : {}),
    };
  };
}
