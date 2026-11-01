/**
 * One real agent turn per trial, through the runtime skills pathway with a
 * controlled pool: the trial workspace gets the task's files, the skills
 * index is built from the pool root alone (filtered by name), the arm's
 * order is applied to the index with `reorderSkillsPrompt`, and the journal
 * says which pool skill (if any) the run actually read. Adapted from the
 * PLAN-45 ablation executor; memory writers are off and the transcript dies
 * with the trial directory.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId } from "../../src/agents/agent-scope.js";
import { runEmbeddedPiAgent } from "../../src/agents/embedded-runner.js";
import { reorderSkillsPrompt, skillOrderInPrompt } from "../../src/agents/skills/skill-prior.js";
import {
  collectTrialEgress,
  registerTrialDeclaredHosts,
} from "../../src/agents/skills/validation-egress.js";
import { buildWorkspaceSkillSnapshot } from "../../src/agents/skills/workspace.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import { getActiveEventJournal } from "../../src/infra/event-journal.js";
import { scoreTaskAnswer } from "../../src/memory/skill-evolution/task-corpus.js";
import {
  registerTrialWorkspace,
  writeTaskFiles,
} from "../../src/memory/skill-evolution/task-runner.js";
import { makeSkillEvolveValidationSessionKey } from "../../src/sessions/session-key-utils.js";
import { disableMemory } from "../skill-evolution/ablation/executors.js";
import { POOL, poolSkillFromPath, writePool } from "./pool.js";
import type { Instance } from "./tasks.js";

export interface TrialSpec {
  phase: string;
  arm: string;
  instance: Instance;
  trialIndex: number;
  /** Pool skill names to include in the index (empty = no skills). */
  skills: readonly string[];
  /** Desired index order (names); names not listed keep their relative order. */
  order?: readonly string[];
}

export interface TrialRecord {
  key: string;
  phase: string;
  arm: string;
  taskId: string;
  family: string;
  seed: number;
  trialIndex: number;
  /** Index order the model actually saw. */
  indexOrder: string[];
  pass: 0 | 1;
  /** Pool skills whose SKILL.md the run read, in order of first read. */
  read: string[];
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  wallMs: number;
  model: string;
  error: string | null;
  runId: string;
}

export function trialKey(spec: TrialSpec): string {
  return `${spec.phase}|${spec.arm}|${spec.instance.task.id}|${spec.trialIndex}`;
}

export interface ExecutorDeps {
  cfg: BitterbotConfig;
  /** An empty directory, so no bundled or managed skill leaks into the index. */
  emptyRoot: string;
  trialsRoot: string;
  modelSpec: string;
  timeoutMs?: number;
  keepTrialDirs?: boolean;
}

function splitSpec(spec: string): { provider: string; model: string } {
  const i = spec.indexOf("/");
  return i > 0
    ? { provider: spec.slice(0, i), model: spec.slice(i + 1) }
    : { provider: "anthropic", model: spec };
}

/**
 * Pool skills whose SKILL.md this run actually read (journal-observed, in
 * first-read order). A `read` counts only when its result row is `ok`: an
 * attempt the sandbox refused is not a read.
 */
export function poolSkillsRead(runId: string, poolRoot: string): string[] | null {
  const journal = getActiveEventJournal();
  if (!journal || journal.queryMeta({ runId, limit: 1 }).length === 0) {
    return null;
  }
  const rows = journal.query({ runId, streams: ["tool"], limit: 4_000 });
  const attempts = new Map<string, string>();
  const okCalls = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const d = row.data as Record<string, unknown>;
    const callId = typeof d.toolCallId === "string" ? d.toolCallId : "";
    if (d.phase === "start") {
      const args = (d.args ?? {}) as Record<string, unknown>;
      let hit: string | null = null;
      if (d.name === "read") {
        const p = [args.path, args.file_path, args.filePath].find((v) => typeof v === "string") as
          | string
          | undefined;
        hit = p ? poolSkillFromPath(poolRoot, p) : null;
      } else if (d.name === "exec" && typeof args.command === "string") {
        const m = args.command.match(/(\S*\/xp-[a-z0-9-]+\/SKILL\.md)/);
        hit = m?.[1] ? poolSkillFromPath(poolRoot, m[1]) : null;
      }
      if (hit && callId) {
        attempts.set(callId, hit);
      }
    } else if (callId && d.isError !== true && d.outcome !== "error") {
      okCalls.add(callId);
    }
  }
  for (const [callId, skill] of attempts) {
    if (okCalls.has(callId) && !out.includes(skill)) {
      out.push(skill);
    }
  }
  return out;
}

export function makeExecutor(deps: ExecutorDeps) {
  process.env.BITTERBOT_MEMORY_OFF = "1";
  const cfg = disableMemory(deps.cfg);
  const agentId = resolveDefaultAgentId(cfg);
  const { provider, model } = splitSpec(deps.modelSpec);
  return async (spec: TrialSpec): Promise<TrialRecord> => {
    const safeTask = spec.instance.task.id.replace(/[^a-z0-9._-]/gi, "_");
    const trialDir = path.join(
      deps.trialsRoot,
      spec.phase,
      spec.arm,
      safeTask,
      String(spec.trialIndex),
    );
    const workspaceDir = path.join(trialDir, "workspace");
    await fs.rm(trialDir, { recursive: true, force: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeTaskFiles(workspaceDir, spec.instance.task);
    // The validation session is workspace-scoped (tools.fs.workspaceOnly), so
    // the pool must live INSIDE the trial workspace or every SKILL.md read is
    // refused as a sandbox escape. Only the arm's skills are written.
    const skillsRoot = path.join(workspaceDir, "skills");
    await writePool(
      skillsRoot,
      POOL.filter((s) => spec.skills.includes(s.name)),
    );
    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      config: cfg,
      managedSkillsDir: deps.emptyRoot,
      bundledSkillsDir: deps.emptyRoot,
      skillFilter: spec.skills.length > 0 ? [...spec.skills] : ["__none__"],
    });
    if (spec.order && spec.order.length > 0) {
      snapshot.prompt = reorderSkillsPrompt(snapshot.prompt, spec.order);
    }
    const indexOrder = skillOrderInPrompt(snapshot.prompt);
    const runId = crypto.randomUUID();
    const sessionKey = makeSkillEvolveValidationSessionKey(agentId, runId.slice(0, 8));
    registerTrialWorkspace(workspaceDir);
    registerTrialDeclaredHosts(workspaceDir, []);
    const started = Date.now();
    let text = "";
    let usage:
      | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
      | undefined;
    let error: string | null = null;
    try {
      const result = await runEmbeddedPiAgent({
        sessionId: `skill-prior-${runId}`,
        sessionKey,
        agentId,
        sessionFile: path.join(trialDir, "session.jsonl"),
        workspaceDir,
        config: cfg,
        prompt: spec.instance.task.prompt,
        provider,
        model,
        skillsSnapshot: snapshot,
        timeoutMs: deps.timeoutMs ?? spec.instance.task.timeoutMs ?? 180_000,
        runId,
        requireExplicitMessageTarget: true,
        disableMessageTool: true,
        lane: "ablation",
      });
      // Every payload: the final answer line is usually in the last one.
      text = (result.payloads ?? [])
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
      usage = result.meta?.agentMeta?.usage;
      if (result.meta?.error) {
        error = String(result.meta.error.message ?? result.meta.error);
      }
    } catch (err) {
      error = String(err);
    }
    collectTrialEgress(workspaceDir);
    const read = poolSkillsRead(runId, skillsRoot) ?? [];
    if (!deps.keepTrialDirs) {
      await fs.rm(trialDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      key: trialKey(spec),
      phase: spec.phase,
      arm: spec.arm,
      taskId: spec.instance.task.id,
      family: spec.instance.family,
      seed: spec.instance.seed,
      trialIndex: spec.trialIndex,
      indexOrder,
      pass: text ? scoreTaskAnswer(spec.instance.task, text) : 0,
      read,
      tokensIn: (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
      tokensOut: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      wallMs: Date.now() - started,
      model: deps.modelSpec,
      error,
      runId,
    };
  };
}

/** Public list prices per million tokens for the models this harness runs. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "anthropic/claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "anthropic/claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
};

export function estimateUsd(
  r: Pick<TrialRecord, "tokensIn" | "tokensOut" | "cacheRead" | "model">,
): number {
  const p = PRICES[r.model] ?? PRICES["anthropic/claude-sonnet-4-6"]!;
  const uncached = Math.max(0, r.tokensIn - r.cacheRead);
  return (uncached * p.input + r.cacheRead * p.cacheRead + r.tokensOut * p.output) / 1e6;
}
