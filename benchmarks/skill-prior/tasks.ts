/**
 * Seeded task instances for the skill prior test. Uses the canonical
 * capability templates with the SAME seed derivation as the canonical
 * corpus, so a (seed, family) pair here is the instance the validation gate
 * would draw for that seed. Ids carry the seed so paired analysis can key
 * on the instance.
 */

import { createHash } from "node:crypto";
import { CAPABILITY_TEMPLATES } from "../../src/memory/skill-evolution/canonical-capability.js";
import type { CorpusTask } from "../../src/memory/skill-evolution/task-corpus.js";
import { FAMILIES, type Family } from "./pool.js";

type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Instance {
  task: CorpusTask;
  family: Family;
  seed: number;
}

export function familyOfTask(task: CorpusTask): Family {
  const fam = (task.tags ?? []).find((t): t is Family =>
    (FAMILIES as readonly string[]).includes(t),
  );
  if (!fam) {
    throw new Error(`task ${task.id} carries no known family tag`);
  }
  return fam;
}

/** One instance per family for `seed`, matching canonical-corpus.ts's draw. */
export function instancesForSeed(seed: number, families: readonly Family[] = FAMILIES): Instance[] {
  const s = seed >>> 0;
  return CAPABILITY_TEMPLATES.map((template, i) => {
    const task = template(mulberry32((s ^ ((i + 101) * 0x9e3779b9) ^ 0x5bd1e995) >>> 0));
    const family = familyOfTask(task);
    if (FAMILIES[i] !== family) {
      throw new Error(`template ${i} produced family ${family}, expected ${FAMILIES[i]}`);
    }
    return { task: { ...task, id: `${task.id}-s${s}` }, family, seed: s };
  }).filter((inst) => families.includes(inst.family));
}

/** Deterministic 50/25/25 split of seeds by sha256(seed) (PLAN-59's pattern). */
export type Split = "development" | "qualification" | "final";
export function splitOfSeed(seed: number, salt = "skill-prior-v1"): Split {
  const h = createHash("sha256").update(`${salt}:${seed}`).digest();
  const u = h.readUInt32BE(0) / 0x100000000;
  return u < 0.5 ? "development" : u < 0.75 ? "qualification" : "final";
}

export function seedsIn(split: Split, from: number, count: number, salt?: string): number[] {
  const out: number[] = [];
  for (let s = from; out.length < count && s < from + 100_000; s++) {
    if (splitOfSeed(s, salt) === split) {
      out.push(s);
    }
  }
  return out;
}

/**
 * The UNDERSPECIFIED variant: the clause that disambiguates the rule is
 * removed from the prompt, so the correct skill carries information the task
 * text no longer does (inclusive range, zero-based index, transitive count,
 * the identifier format, negatives count, ERROR only). Truth is unchanged.
 * Families whose prompts cannot be made ambiguous without changing the
 * answer (config-diff, csv-filter-sum, multi-file-rename) are left as is.
 */
export function underspecify(task: CorpusTask): CorpusTask {
  const family = familyOfTask(task);
  let prompt = task.prompt;
  switch (family) {
    case "ledger-sum":
      prompt = prompt.replace(" (amounts can be negative)", "");
      break;
    case "log-triage":
      prompt = prompt.replace("the most ERROR-level lines", "the most error lines");
      break;
    case "dep-depth":
      prompt = prompt.replace(
        / depend on transitively \(direct and indirect, not counting itself\)\?/,
        " depend on?",
      );
      break;
    case "regex-valid":
      prompt = prompt.replace(
        /A VALID identifier is exactly three uppercase ASCII letters, a hyphen, and exactly four digits, with nothing else on the line\./,
        "A VALID identifier follows the standard identifier format.",
      );
      break;
    case "json-path":
      prompt = prompt.replace(" (zero-based index)", "");
      break;
    case "date-window":
      prompt = prompt.replace(" inclusive?", "?");
      break;
    default:
      break;
  }
  return { ...task, prompt };
}

export type TaskVariant = "specified" | "underspecified";

export function applyVariant(instances: Instance[], variant: TaskVariant): Instance[] {
  if (variant === "specified") {
    return instances;
  }
  return instances.map((inst) => ({ ...inst, task: underspecify(inst.task) }));
}
