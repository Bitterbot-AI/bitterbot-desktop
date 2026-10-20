/**
 * PLAN-45 5.1: the ablation plan. Pure: arms x corpora x models x tasks x
 * trials -> a deterministic trial list. No I/O.
 */

import type { CorpusTask } from "../../../src/memory/skill-evolution/task-corpus.js";

export const ARM_IDS = ["none", "harvested", "evolved", "in-context"] as const;
export type ArmKind = (typeof ARM_IDS)[number];
/** `none` | `harvested` | `evolved` | `evolved:<skill>` | `in-context:<skill>` (5.2 pairs per skill). */
export type ArmId = string;

export function armKind(id: ArmId): ArmKind {
  const base = id.split(":")[0] ?? id;
  return (ARM_IDS as readonly string[]).includes(base) ? (base as ArmKind) : "none";
}
export const CORPUS_IDS = ["frozen", "fresh", "private", "external"] as const;
export type CorpusId = (typeof CORPUS_IDS)[number];
export const MODEL_IDS = ["primary", "cheap"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export interface ResolvedArm {
  id: ArmId;
  /** Skill names in the arm's index (empty for none / in-context). */
  skillNames: string[];
  /** In-context block prepended to every task prompt (in-context arm only). */
  contextBlock: string | null;
  /** Why the arm is empty or skipped, for the report. */
  note: string | null;
}

export interface ResolvedCorpus {
  id: CorpusId;
  version: string;
  tasks: CorpusTask[];
  note: string | null;
}

export interface ResolvedModel {
  id: ModelId;
  /** `provider/model` spec. */
  spec: string;
}

export interface Trial {
  key: string;
  arm: ArmId;
  corpus: CorpusId;
  model: ModelId;
  task: CorpusTask;
  trialIndex: number;
}

/**
 * Deterministic truncation PER SUITE (adversarial 5-2): the cap bounds the
 * regression suite and the capability suite separately, so a capped run
 * can never lose the tasks the paired statistics live on. Capability
 * first, stable id order.
 */
export function capTasks(tasks: readonly CorpusTask[], cap: number): CorpusTask[] {
  const cap_ = [...tasks]
    .filter((t) => t.suite !== "regression")
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const reg = [...tasks]
    .filter((t) => t.suite === "regression")
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return cap > 0 ? [...cap_.slice(0, cap), ...reg.slice(0, cap)] : [...cap_, ...reg];
}

export function planTrials(params: {
  arms: readonly ResolvedArm[];
  corpora: readonly ResolvedCorpus[];
  models: readonly ResolvedModel[];
  trialsPerTask: number;
  cap: number;
}): Trial[] {
  const out: Trial[] = [];
  for (const model of params.models) {
    for (const corpus of params.corpora) {
      const tasks = capTasks(corpus.tasks, params.cap);
      for (const arm of params.arms) {
        if (arm.skillNames.length === 0 && arm.id !== "none" && !arm.contextBlock) {
          continue; // an empty non-baseline arm has nothing to measure
        }
        for (const task of tasks) {
          for (let i = 0; i < params.trialsPerTask; i++) {
            out.push({
              key: `${model.id}|${corpus.id}|${arm.id}|${task.id}|${i}`,
              arm: arm.id,
              corpus: corpus.id,
              model: model.id,
              task,
              trialIndex: i,
            });
          }
        }
      }
    }
  }
  return out;
}
