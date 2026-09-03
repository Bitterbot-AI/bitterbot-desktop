/**
 * PLAN-43 Phase 0/§3.6 + corpus/gate upgrade (2026-09-02 research pass):
 * the CANONICAL base corpus, now GENERATOR-SEEDED.
 *
 * Why generators instead of frozen instances: a small frozen public task
 * set is memorizable — passively (GSM1k measured 8-13% score inflation
 * from contamination alone, arXiv:2405.00332) and adversarially (a
 * marketplace seller can hard-code the answers into a skill and ace the
 * trust baseline). The robust fix compatible with decentralized LOCAL
 * verification is constructive generation (DyVal, arXiv:2309.17167): each
 * canonical task is `template(seed) → (instance, ground truth)`. The
 * release signs the GENERATOR CODE (it ships inside the release artifact,
 * same trust story as before); memorizing any instance buys nothing
 * because the verifier draws a fresh seed.
 *
 * The frozen EXEMPLAR (seed 0) still exists: it is byte-locked to
 * benchmarks/skill-evolution/canonical-corpus.jsonl and SHA-256 pinned, as
 * the human-reviewable form of the corpus and as memorization telemetry —
 * a large exemplar-vs-fresh-seed score gap flags an overfit skill
 * (functional-benchmark alarm, arXiv:2402.19450).
 *
 * These canonical tasks are the REGRESSION suite (suite: "regression"):
 * near-ceiling generics that gate "no new failures". They deliberately do
 * NOT carry the promotion signal — that lives in the node's grown
 * capability suite (task-corpus.jsonl), sourced from real failure traces.
 *
 * Every prompt demands a structured `FINAL: <answer>` line and every
 * checker is the hardened "final" kind (exact compare on the captured
 * value) — bare substring checks have documented 20-60% false-pass modes.
 *
 * Updating the templates = a new generator version = a release act; bump
 * CANONICAL_GENERATOR_VERSION, regenerate the exemplar file, update the
 * pin (the test states the expected values).
 */

import { createHash, randomBytes } from "node:crypto";
import type { ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  loadTaskCorpus,
  MAX_CORPUS_TASKS,
  type CorpusTask,
  type TaskCorpus,
} from "./task-corpus.js";

const log = createSubsystemLogger("skill-evolution/canonical-corpus");

/** Bump on ANY template change; verdicts are comparable only within one version. */
export const CANONICAL_GENERATOR_VERSION = 3;

/** SHA-256 of the seed-0 exemplar JSONL (integrity pin; test-enforced). */
export const CANONICAL_EXEMPLAR_SHA256 =
  "c41f2f1879013429350de30dc27961bcc6290fabb8bc7299bfd2d732f1d8b560";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32 — matches bootstrap-ci.ts) + draw helpers
// ---------------------------------------------------------------------------

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

const TOKEN_WORDS = [
  "amber",
  "basalt",
  "cobalt",
  "delta",
  "ember",
  "fjord",
  "garnet",
  "harbor",
  "indigo",
  "juniper",
  "krill",
  "lumen",
  "mica",
  "nectar",
  "onyx",
  "pumice",
  "quartz",
  "russet",
  "sable",
  "tundra",
] as const;

function token(rng: Rng): string {
  return `${pick(rng, TOKEN_WORDS)}-${pick(rng, TOKEN_WORDS)}-${int(rng, 10, 99)}`;
}

const FINAL_INSTRUCTION = 'Reply with exactly one line of the form "FINAL: <answer>".';

function finalTask(id: string, prompt: string, answer: string, tags: string[]): CorpusTask {
  return {
    id,
    prompt: `${prompt} ${FINAL_INSTRUCTION}`,
    checker: { kind: "final", value: answer },
    tags,
    suite: "regression",
  };
}

// ---------------------------------------------------------------------------
// Templates: template(rng) → task with ground truth computed alongside
// ---------------------------------------------------------------------------

const TEMPLATES: Array<(rng: Rng) => CorpusTask> = [
  (rng) => {
    const a = int(rng, 12, 97);
    const b = int(rng, 12, 97);
    return finalTask("arith-basic", `What is ${a} * ${b}?`, String(a * b), ["reasoning"]);
  },
  (rng) => {
    const t = token(rng);
    return finalTask(
      "exec-echo",
      `Run the shell command \`echo ${t}\` and report the exact output line.`,
      t,
      ["exec"],
    );
  },
  (rng) => {
    const t = token(rng);
    return finalTask(
      "file-roundtrip",
      `Create a file named corpus-test.txt in your workspace containing exactly the text ${t}, then read the file back and report its contents.`,
      t,
      ["exec", "files"],
    );
  },
  (rng) => {
    const t = token(rng);
    const decoy = token(rng);
    return finalTask(
      "json-extract",
      `Parse this JSON and report the value of key x: {"x": "${t}", "y": "${decoy}"}`,
      t,
      ["reasoning"],
    );
  },
  (rng) => {
    const word = pick(rng, TOKEN_WORDS);
    const vowels = (word.match(/[aeiou]/g) ?? []).length;
    return finalTask(
      "vowel-count",
      `How many vowels (a, e, i, o, u) are in the word ${word}?`,
      String(vowels),
      ["reasoning"],
    );
  },
  (rng) => {
    const y = int(rng, 2020, 2030);
    const m = int(rng, 1, 12);
    const d = int(rng, 1, 28);
    const pad = (n: number) => String(n).padStart(2, "0");
    return finalTask(
      "date-format",
      `Convert the date ${y}-${pad(m)}-${pad(d)} to DD/MM/YYYY format.`,
      `${pad(d)}/${pad(m)}/${y}`,
      ["reasoning"],
    );
  },
  (rng) => {
    const uniq: number[] = [];
    while (uniq.length < 4) {
      const n = int(rng, 2, 99);
      if (!uniq.includes(n)) {
        uniq.push(n);
      }
    }
    const sorted = [...uniq].toSorted((x, y) => x - y);
    return finalTask(
      "sort-numbers",
      `Sort these numbers in ascending order and report them comma-separated with a single space after each comma: ${uniq.join(", ")}.`,
      sorted.join(", "),
      ["reasoning"],
    );
  },
  (rng) => {
    const t = token(rng);
    const digest = createHash("sha1").update(t).digest("hex").slice(0, 8);
    return finalTask(
      "exec-sha1",
      `Use the shell to compute the SHA-1 hash of the string ${t} (no trailing newline) and report the first 8 hex characters of the digest.`,
      digest,
      ["exec"],
    );
  },
  (rng) => {
    const t = token(rng);
    const b64 = Buffer.from(t, "utf-8").toString("base64");
    return finalTask(
      "base64-decode",
      `Decode this base64 string and report the plaintext: ${b64}`,
      t,
      ["reasoning", "exec"],
    );
  },
  (rng) => {
    const words = Array.from({ length: 5 }, () => pick(rng, TOKEN_WORDS));
    const idx = int(rng, 2, 4);
    const ordinal = ["", "1st", "2nd", "3rd", "4th", "5th"][idx] as string;
    return finalTask(
      "word-extract",
      `What is the ${ordinal} word of this list: ${words.join(" ")}.`,
      words[idx - 1] as string,
      ["reasoning"],
    );
  },
  (rng) => {
    const km = int(rng, 2, 90) / 2; // .0 or .5 steps
    return finalTask(
      "unit-convert",
      `Convert ${km} kilometers to meters. Report just the integer number of meters.`,
      String(Math.round(km * 1000)),
      ["reasoning"],
    );
  },
  (rng) => {
    const a = int(rng, 5, 30);
    const b = int(rng, 3, 20);
    const c = int(rng, 2, 9);
    const d = int(rng, 1, 15);
    return finalTask(
      "multi-step-arith",
      `Compute (${a} + ${b}) * ${c}, then subtract ${d}.`,
      String((a + b) * c - d),
      ["reasoning"],
    );
  },
];

// ---------------------------------------------------------------------------
// Generation + seeds
// ---------------------------------------------------------------------------

/** Materialize the canonical corpus for a seed. Deterministic per (version, seed). */
export function generateCanonicalCorpus(seed: number): TaskCorpus {
  const s = seed >>> 0;
  const tasks = TEMPLATES.map((template, i) => template(mulberry32((s ^ (i * 0x9e3779b9)) >>> 0)));
  return { tasks, version: `canonical-g${CANONICAL_GENERATOR_VERSION}-s${s}` };
}

/** Fresh unpredictable seed for a validation run (recorded with the verdict). */
export function randomCanonicalSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

/**
 * Deterministic seed from shared inputs, for cross-node agreement (e.g.
 * marketplace re-scoring: H(skill hash ‖ corpus version ‖ verifier nonce)).
 */
export function deriveCanonicalSeed(...parts: string[]): number {
  return createHash("sha256").update(parts.join("\u0000")).digest().readUInt32BE(0);
}

/** The seed-0 exemplar as JSONL — the human-reviewable, byte-pinned form. */
export function canonicalExemplarJsonl(): string {
  return `${generateCanonicalCorpus(0)
    .tasks.map((t) => JSON.stringify(t))
    .join("\n")}\n`;
}

/**
 * Load the canonical corpus. Fails closed (null + warn) if the seed-0
 * exemplar no longer matches its pin — a corrupted or tampered build must
 * not silently become the trust baseline.
 */
export function loadCanonicalCorpus(seed = 0): TaskCorpus | null {
  const sha256 = createHash("sha256").update(canonicalExemplarJsonl()).digest("hex");
  if (sha256 !== CANONICAL_EXEMPLAR_SHA256) {
    log.warn(
      `canonical corpus integrity check FAILED (got ${sha256.slice(0, 12)}…, pinned ${CANONICAL_EXEMPLAR_SHA256.slice(0, 12)}…); refusing to use it`,
    );
    return null;
  }
  return generateCanonicalCorpus(seed);
}

/**
 * The corpus a trust decision actually runs on: canonical regression
 * baseline (freshly seeded) plus the node's grown capability corpus.
 * Grown tasks whose ids collide with canonical ones are dropped — the
 * baseline is immutable. A brand-new node always has at least the
 * canonical tasks.
 */
export async function loadEffectiveCorpus(
  opts: ImpactTrailOptions = {},
  seed = 0,
): Promise<TaskCorpus | null> {
  const canonical = loadCanonicalCorpus(seed);
  const grown = await loadTaskCorpus(opts);
  if (!canonical) {
    return grown; // tampered/corrupt build: degrade to prior behavior
  }
  if (!grown) {
    return canonical;
  }
  const canonicalIds = new Set(canonical.tasks.map((t) => t.id));
  // The MAX_CORPUS_TASKS validation-cost bound holds for the merged set:
  // canonical tasks are always kept whole; grown tasks fill the remainder.
  const grownBudget = Math.max(0, MAX_CORPUS_TASKS - canonical.tasks.length);
  const merged = [
    ...canonical.tasks,
    ...grown.tasks.filter((t) => !canonicalIds.has(t.id)).slice(0, grownBudget),
  ];
  return { tasks: merged, version: `${canonical.version}+${grown.version}` };
}
