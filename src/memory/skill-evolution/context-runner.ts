/**
 * PLAN-45 5.2: the runner for an in-context arm. A sibling of the runtime
 * pathway runner: same scratch workspace, same task files, same session
 * flavor and tool profile, same egress accounting; the only difference is
 * that NO skill file is written (so the skills index is empty for the arm)
 * and the context block rides in the user message ahead of the task.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import type { EventJournal } from "../../infra/event-journal.js";
import type { CorpusTask } from "./task-corpus.js";
import type { TaskRunnerFn, TaskVariant, TrialContext, TrialResult } from "./validate-tasks.js";
import {
  collectTrialEgress,
  registerTrialDeclaredHosts,
} from "../../agents/skills/validation-egress.js";
import {
  type AgentTurnFn,
  type AgentTurnOutcome,
  consumeTrialWorkspace,
  registerTrialWorkspace,
  trialsRoot,
  writeTaskFiles,
} from "./task-runner.js";

export interface ContextRunnerDeps {
  agentTurn: AgentTurnFn;
  /** The block for the `candidate` variant; null = plain task (no context). */
  candidateContext: string | null;
  /** The block for the `incumbent` variant; null = plain task. */
  incumbentContext: string | null;
  proposalId: string;
  storeOpts?: ImpactTrailOptions;
  journal?: EventJournal | null;
  keepTrialDirs?: boolean;
}

function normalize(r: string | AgentTurnOutcome): AgentTurnOutcome {
  return typeof r === "string" ? { text: r } : r;
}

export function composeContextPrompt(task: CorpusTask, context: string | null): string {
  return context ? `${context}\n\n${task.prompt}` : task.prompt;
}

export function makeContextRunner(deps: ContextRunnerDeps): TaskRunnerFn {
  const safeProposal = deps.proposalId.replace(/[^a-z0-9._-]/gi, "_").slice(0, 64);
  return async (
    task: CorpusTask,
    variant: TaskVariant,
    ctx: TrialContext,
  ): Promise<TrialResult> => {
    const context = variant === "candidate" ? deps.candidateContext : deps.incumbentContext;
    const trialDir = path.join(
      trialsRoot(deps.storeOpts),
      safeProposal,
      task.id.replace(/[^a-z0-9._-]/gi, "_").slice(0, 64),
      `${variant}-ctx-${ctx.trialIndex}`,
    );
    const workspaceDir = path.join(trialDir, "workspace");
    await fs.rm(trialDir, { recursive: true, force: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeTaskFiles(workspaceDir, task);
    try {
      registerTrialWorkspace(workspaceDir);
      registerTrialDeclaredHosts(workspaceDir, []);
      const r = normalize(
        await deps.agentTurn(composeContextPrompt(task, context), {
          workspaceDir,
          ...(task.timeoutMs ? { timeoutMs: task.timeoutMs } : {}),
        }),
      );
      consumeTrialWorkspace(workspaceDir);
      const egress = collectTrialEgress(workspaceDir).map((e) => ({
        tool: e.tool,
        host: e.host,
        declared: e.declared,
      }));
      return {
        answer: r.text,
        // Nothing to read: neutral for the credited-win rule.
        skillRead: null,
        egress,
        ...(r.usage ? { usage: r.usage } : {}),
      };
    } finally {
      if (!deps.keepTrialDirs) {
        await fs.rm(trialDir, { recursive: true, force: true }).catch(() => undefined);
        for (const dir of [path.dirname(trialDir), path.dirname(path.dirname(trialDir))]) {
          await fs.rmdir(dir).catch(() => undefined);
        }
      }
    }
  };
}
