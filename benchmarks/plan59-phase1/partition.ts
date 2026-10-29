/**
 * PLAN-59 Phase 1: three-way question partition by family.
 *
 * A family is the gold chunk's `path` (one session transcript or memory file).
 * Families are ordered by `sha256(seed + ":" + path)` and cut 50 / 25 / 25 into
 * development, qualification and final. Every question of a family lands in
 * the same split, so no paraphrase of a development passage can leak into
 * qualification or final.
 *
 * The final split is never read by selection or estimation. `assertFinalAllowed`
 * is the only gate through which a scorer may touch it, and it opens only when
 * the caller passes `--final` together with the SHA-256 of a protocol file that
 * declares itself frozen. The pilot does not run that path.
 */
import { readFileSync } from "node:fs";
import { type Question, familyOf, sha256 } from "./common.js";

export type Split = "development" | "qualification" | "final";
export const SPLITS: readonly Split[] = ["development", "qualification", "final"];

export type PartitionAssignment = { chunkId: string; familyHash: string; split: Split };

export type Partition = {
  version: 1;
  seed: string;
  createdAt: string;
  /** SHA-256 of the question file the partition was cut from. */
  questionsSha256: string;
  shares: { development: number; qualification: number; final: number };
  counts: Record<Split, { questions: number; families: number }>;
  /** chunk ids and family hashes only; never a path or a question. */
  assignments: PartitionAssignment[];
};

export const familyHash = (seed: string, path: string): string => sha256(`${seed}:${path}`);

export function partitionQuestions(
  questions: readonly Question[],
  params: { seed: string; questionsSha256: string; createdAt?: string },
): Partition {
  const shares = { development: 0.5, qualification: 0.25, final: 0.25 };
  const byFamily = new Map<string, Question[]>();
  for (const q of questions) {
    const fam = familyOf(q);
    const list = byFamily.get(fam) ?? [];
    list.push(q);
    byFamily.set(fam, list);
  }
  const families = [...byFamily.keys()]
    .map((path) => ({ path, hash: familyHash(params.seed, path) }))
    .toSorted((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const n = families.length;
  const devEnd = Math.floor(n * shares.development);
  const qualEnd = devEnd + Math.floor(n * shares.qualification);
  const splitOf = new Map<string, Split>();
  families.forEach((f, i) => {
    splitOf.set(f.path, i < devEnd ? "development" : i < qualEnd ? "qualification" : "final");
  });
  const counts: Partition["counts"] = {
    development: { questions: 0, families: 0 },
    qualification: { questions: 0, families: 0 },
    final: { questions: 0, families: 0 },
  };
  for (const f of families) {
    const split = splitOf.get(f.path)!;
    counts[split].families += 1;
    counts[split].questions += byFamily.get(f.path)!.length;
  }
  const assignments: PartitionAssignment[] = questions.map((q) => ({
    chunkId: q.chunkId,
    familyHash: familyHash(params.seed, familyOf(q)),
    split: splitOf.get(familyOf(q))!,
  }));
  return {
    version: 1,
    seed: params.seed,
    createdAt: params.createdAt ?? new Date().toISOString(),
    questionsSha256: params.questionsSha256,
    shares,
    counts,
    assignments,
  };
}

/**
 * The questions of one split, in question-file order. Throws when the
 * partition was cut from a different question file. The final split is
 * refused here unless the caller presents an opened final gate (see
 * `assertFinalAllowed`), so no estimation or selection code path can reach it
 * by accident.
 */
export function questionsIn(
  split: Split,
  questions: readonly Question[],
  partition: Partition,
  opts?: { questionsSha256?: string; finalGate?: FinalGate },
): Question[] {
  if (opts?.questionsSha256 && opts.questionsSha256 !== partition.questionsSha256) {
    throw new Error("partition was cut from a different question file (sha256 mismatch)");
  }
  if (split === "final" && !opts?.finalGate?.opened) {
    throw new Error(
      "the final partition is sealed: pass --final with --freeze <sha256 of the frozen protocol file>",
    );
  }
  const splitOf = new Map(partition.assignments.map((a) => [a.chunkId, a.split] as const));
  const out: Question[] = [];
  for (const q of questions) {
    const s = splitOf.get(q.chunkId);
    if (s === undefined) {
      throw new Error(`question ${q.chunkId} is not in the partition`);
    }
    if (s === split) {
      out.push(q);
    }
  }
  return out;
}

export type FinalGate = { opened: true; protocolSha256: string };

/**
 * Open the final gate. Requires `final` to be requested explicitly, a protocol
 * file that exists and contains the line `status: frozen`, and a `freeze`
 * hash equal to that file's SHA-256. Anything else throws.
 */
export function assertFinalAllowed(params: {
  final: boolean;
  freeze?: string;
  protocolPath: string;
}): FinalGate {
  if (!params.final) {
    throw new Error("final partition requested without --final");
  }
  if (!params.freeze) {
    throw new Error("--final requires --freeze <sha256 of the frozen protocol file>");
  }
  let body: string;
  try {
    body = readFileSync(params.protocolPath, "utf-8");
  } catch {
    throw new Error(`no frozen protocol file at ${params.protocolPath}`);
  }
  if (!/^status:\s*frozen\s*$/m.test(body)) {
    throw new Error("protocol file is not marked `status: frozen`");
  }
  const actual = sha256(body);
  if (actual !== params.freeze.trim().toLowerCase()) {
    throw new Error("--freeze does not match the protocol file's sha256");
  }
  return { opened: true, protocolSha256: actual };
}
