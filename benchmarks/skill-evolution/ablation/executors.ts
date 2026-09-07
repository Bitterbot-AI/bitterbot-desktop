/**
 * PLAN-45 5.1: executors. `embedded` runs a real agent turn in-process
 * (per-arm skills snapshot, per-arm model, the validation session flavor
 * so the prompt shape and tool profile match the gate); `oracle` is a
 * deterministic keyless executor for CI self-tests and report goldens.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BitterbotConfig } from "../../../src/config/config.js";
import type { ModelId, ResolvedArm, ResolvedModel, Trial } from "./plan.js";
import type { TrialRecord } from "./stats.js";
import { resolveDefaultAgentId } from "../../../src/agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../../../src/agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../../src/agents/pi-embedded-runner.js";
import { resolveStorageRoots } from "../../../src/agents/skills/skill-storage.js";
import {
  collectTrialEgress,
  registerTrialDeclaredHosts,
} from "../../../src/agents/skills/validation-egress.js";
import { buildWorkspaceSkillSnapshot } from "../../../src/agents/skills/workspace.js";
import { getActiveEventJournal } from "../../../src/infra/event-journal.js";
import { scoreTaskAnswer } from "../../../src/memory/skill-evolution/task-corpus.js";
import {
  registerTrialWorkspace,
  writeTaskFiles,
} from "../../../src/memory/skill-evolution/task-runner.js";
import { makeSkillEvolveValidationSessionKey } from "../../../src/sessions/session-key-utils.js";

export type Executor = (
  trial: Trial,
  arm: ResolvedArm,
  model: ResolvedModel,
) => Promise<TrialRecord>;

/** Model specs for the two arms, from the node's config and environment. */
export function resolveModels(cfg: BitterbotConfig, ids: readonly ModelId[]): ResolvedModel[] {
  const agentId = resolveDefaultAgentId(cfg);
  const out: ResolvedModel[] = [];
  for (const id of ids) {
    if (id === "primary") {
      const ref = resolveDefaultModelForAgent({ cfg, agentId });
      out.push({ id, spec: `${ref.provider}/${ref.model}` });
    } else {
      out.push({
        id,
        spec: process.env.ANTHROPIC_API_KEY ? "anthropic/claude-haiku-4-5" : "openai/gpt-4o-mini",
      });
    }
  }
  return out;
}

function splitSpec(spec: string): { provider: string; model: string } {
  const i = spec.indexOf("/");
  return i > 0
    ? { provider: spec.slice(0, i), model: spec.slice(i + 1) }
    : { provider: "anthropic", model: spec };
}

/** A stable pseudo-random pass pattern per (arm, task, trial): the oracle's "behavior". */
export function oraclePass(
  armId: string,
  taskId: string,
  trialIndex: number,
  seed: number,
): boolean {
  const h = crypto.createHash("sha1").update(`${seed}|${armId}|${taskId}|${trialIndex}`).digest();
  // The baseline is weaker so the paired statistics have something to say;
  // every non-baseline arm shares one rate (adversarial 5-7: the oracle
  // must never manufacture an evolved-vs-control difference).
  const bias = armId === "none" ? 0.55 : 0.75;
  return (h.readUInt32BE(0) % 1000) / 1000 < bias;
}

export function makeOracleExecutor(seed: number): Executor {
  return async (trial, arm) => {
    const pass = oraclePass(arm.id, trial.task.id, trial.trialIndex, seed);
    const answer = pass ? `FINAL: ${trial.task.checker.value}` : "FINAL: nope";
    const contextTokens = arm.contextBlock ? Math.ceil(arm.contextBlock.length / 4) : 0;
    return {
      arm: arm.id,
      corpus: trial.corpus,
      model: trial.model,
      taskId: trial.task.id,
      suite: trial.task.suite ?? "capability",
      trialIndex: trial.trialIndex,
      pass: scoreTaskAnswer(trial.task, answer),
      tokensIn: 400 + contextTokens + arm.skillNames.length * 60,
      tokensOut: 40,
      wallMs: 10,
      skillRead: arm.skillNames.length > 0 ? pass : null,
      cacheRead: 0,
      error: null,
    };
  };
}

export interface EmbeddedExecutorDeps {
  cfg: BitterbotConfig;
  configDir?: string;
  trialsRoot?: string;
  keepTrialDirs?: boolean;
  timeoutMs?: number;
}

/**
 * One real turn per trial: scratch workspace with the task's files, the
 * arm's skills snapshot (filtered from the live root; empty for none and
 * in-context), the arm's context block ahead of the prompt, the
 * validation session flavor, the arm's model.
 */
export function makeEmbeddedExecutor(deps: EmbeddedExecutorDeps): Executor {
  // Prompt blocks load their own config, so the off switch is process-wide.
  process.env.BITTERBOT_MEMORY_OFF = "1";
  // A trial must not touch the node's memory (the first live run wrote
  // working-memory state and embeddings from ablation turns).
  const cfg: BitterbotConfig = disableMemory(deps.cfg);
  const agentId = resolveDefaultAgentId(cfg);
  const roots = resolveStorageRoots(deps.configDir ? { configDir: deps.configDir } : {});
  const root = deps.trialsRoot ?? path.join(os.tmpdir(), "bitterbot-ablation");
  return async (trial, arm, model) => {
    const trialDir = path.join(
      root,
      trial.model,
      trial.corpus,
      arm.id,
      trial.task.id.replace(/[^a-z0-9._-]/gi, "_"),
      String(trial.trialIndex),
    );
    const workspaceDir = path.join(trialDir, "workspace");
    await fs.rm(trialDir, { recursive: true, force: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeTaskFiles(workspaceDir, trial.task);
    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      config: cfg,
      managedSkillsDir: roots.liveRoot,
      skillFilter: arm.skillNames,
    });
    const runId = crypto.randomUUID();
    const sessionKey = makeSkillEvolveValidationSessionKey(agentId, runId.slice(0, 8));
    const sessionId = `ablation-${runId}`;
    const { provider, model: modelId } = splitSpec(model.spec);
    const prompt = arm.contextBlock
      ? `${arm.contextBlock}\n\n${trial.task.prompt}`
      : trial.task.prompt;
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
        sessionId,
        sessionKey,
        agentId,
        // The transcript lives in the trial dir and dies with it.
        sessionFile: path.join(trialDir, "session.jsonl"),
        workspaceDir,
        config: cfg,
        prompt,
        provider,
        model: modelId,
        skillsSnapshot: snapshot,
        timeoutMs: deps.timeoutMs ?? trial.task.timeoutMs ?? 120_000,
        runId,
        requireExplicitMessageTarget: true,
        disableMessageTool: true,
        lane: "ablation",
      });
      text = result.payloads?.[0]?.text ?? "";
      usage = result.meta?.agentMeta?.usage;
      if (result.meta?.error) {
        error = String(result.meta.error.message ?? result.meta.error);
      }
    } catch (err) {
      error = String(err);
    }
    collectTrialEgress(workspaceDir);
    const skillRead = arm.skillNames.length > 0 ? readAnyLiveSkill(runId, roots.liveRoot) : null;
    if (!deps.keepTrialDirs) {
      await fs.rm(trialDir, { recursive: true, force: true }).catch(() => undefined);
    }
    // Prompt tokens include what the provider served from its cache
    // (adversarial 5-3): a cache hit is still context the arm paid for.
    const tokensIn = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
    return {
      arm: arm.id,
      corpus: trial.corpus,
      model: trial.model,
      taskId: trial.task.id,
      suite: trial.task.suite ?? "capability",
      trialIndex: trial.trialIndex,
      pass: text ? scoreTaskAnswer(trial.task, text) : 0,
      tokensIn,
      tokensOut: usage?.output ?? 0,
      wallMs: Date.now() - started,
      skillRead,
      cacheRead: usage?.cacheRead ?? 0,
      error,
    };
  };
}

/** Whether the run read any SKILL.md under the live root (journal-observed). */
function readAnyLiveSkill(runId: string, liveRoot: string): boolean | null {
  const journal = getActiveEventJournal();
  if (!journal || journal.queryMeta({ runId, limit: 1 }).length === 0) {
    return null; // unobservable, like the gate's detectSkillRead
  }
  const rows = journal.query({ runId, streams: ["tool"], limit: 2_000 });
  const root = path.resolve(liveRoot);
  for (const row of rows) {
    if (row.data.phase !== "start") {
      continue;
    }
    const args = (row.data.args ?? {}) as Record<string, unknown>;
    const p = [args.path, args.file_path, args.filePath].find((v) => typeof v === "string") as
      | string
      | undefined;
    if (
      row.data.name === "read" &&
      p &&
      path.resolve(p).startsWith(root) &&
      p.endsWith("SKILL.md")
    ) {
      return true;
    }
    if (
      row.data.name === "exec" &&
      typeof args.command === "string" &&
      args.command.includes(root)
    ) {
      return true;
    }
  }
  return false;
}

/** The node's config with every memory writer off: an ablation turn is a measurement, not an experience. */
export function disableMemory(cfg: BitterbotConfig): BitterbotConfig {
  const memory = { ...(cfg.memory ?? {}) } as Record<string, unknown>;
  for (const key of [
    "consolidation",
    "dreamEngine",
    "sessionIndexing",
    "workingMemory",
    "provenance",
    "coverageDiagnostics",
    "canonicalLedger",
  ]) {
    const sub = memory[key];
    memory[key] = {
      ...(sub && typeof sub === "object" ? (sub as Record<string, unknown>) : {}),
      enabled: false,
    };
  }
  const agents = { ...(cfg.agents ?? {}) } as Record<string, unknown>;
  const defaults = { ...((agents.defaults as Record<string, unknown> | undefined) ?? {}) };
  defaults.memorySearch = {
    ...((defaults.memorySearch as Record<string, unknown> | undefined) ?? {}),
    enabled: false,
  };
  agents.defaults = defaults;
  return {
    ...cfg,
    memory: memory as BitterbotConfig["memory"],
    agents: agents as BitterbotConfig["agents"],
  };
}
