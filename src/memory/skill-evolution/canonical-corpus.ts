/**
 * PLAN-43 Phase 0 / PLAN-42 §5.7: the SIGNED CANONICAL base corpus.
 *
 * Two holes are closed by shipping one immutable task corpus with every
 * release:
 *
 *  1. New-node re-validation bootstrap: a brand-new node has no trace
 *     history and no grown corpus, so "re-gate incoming evolved skills on
 *     your own corpus" would either reject everything or blindly trust the
 *     sender's PURPOSE.md. The canonical baseline is always present.
 *  2. Forgeable ranking: a seller-reported validation score is computed on
 *     the SELLER's own (arbitrarily easy) corpus. Trust decisions — re-gate
 *     and marketplace rank — must score against a neutral corpus every node
 *     holds. Seller-reported scores are advisory at most (invariant I10).
 *
 * Trust model, stated honestly: the corpus is EMBEDDED in this module, so
 * it is covered by exactly the trust that covers the shipped code — the
 * release artifact itself. The pinned SHA-256 exists to (a) give the corpus
 * a stable, content-addressed version identity that verdicts record, and
 * (b) let a test pin the repo file `benchmarks/skill-evolution/
 * canonical-corpus.jsonl` byte-for-byte to the embedded copy so the two can
 * never drift. A detached minisign signature attaches to the corpus file at
 * release time once the orchestrator signing keys exist (deploy/relay-fleet/
 * SIGNING.md — same pre-signing posture as scripts/fetch-orchestrator.mjs:
 * hash gate active now, signature slot activates with the key rollout).
 * No signature is checked here because verifying an embedded constant with
 * an embedded key defends against nothing; the corpus never travels outside
 * the signed release. Peers NEVER send each other a canonical corpus.
 *
 * Updating the corpus = a new release: edit the jsonl file, mirror the
 * lines here, update the pins (the test prints the expected values), and
 * never edit a task in place once verdicts reference its version.
 */

import { createHash } from "node:crypto";
import type { ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  loadTaskCorpus,
  MAX_CORPUS_TASKS,
  parseCorpusTasks,
  type TaskCorpus,
} from "./task-corpus.js";

const log = createSubsystemLogger("skill-evolution/canonical-corpus");

/**
 * Byte-exact lines of benchmarks/skill-evolution/canonical-corpus.jsonl
 * (trailing "" reproduces the file's final newline on join("\n")).
 * canonical-corpus.test.ts enforces the equivalence.
 */
const CANONICAL_CORPUS_LINES: string[] = [
  '{"id": "arith-basic", "prompt": "What is 17 * 23? Reply with just the number.", "checker": {"kind": "contains", "value": "391"}, "tags": ["reasoning"]}',
  '{"id": "exec-echo", "prompt": "Run the shell command `echo bitterbot-corpus-check` and report the exact output line.", "checker": {"kind": "contains", "value": "bitterbot-corpus-check"}, "tags": ["exec"]}',
  '{"id": "file-roundtrip", "prompt": "Create a file named corpus-test.txt in your workspace containing exactly the text hello-corpus, then read the file back and report its contents.", "checker": {"kind": "contains", "value": "hello-corpus"}, "tags": ["exec", "files"]}',
  '{"id": "json-extract", "prompt": "Parse this JSON and report the value of key x: {\\"x\\": \\"zebra-42\\", \\"y\\": \\"decoy\\"}", "checker": {"kind": "contains", "value": "zebra-42"}, "tags": ["reasoning"]}',
  '{"id": "vowel-count", "prompt": "How many vowels are in the word evolution? Reply with just the number.", "checker": {"kind": "regex", "value": "\\\\b5\\\\b"}, "tags": ["reasoning"]}',
  '{"id": "date-format", "prompt": "Convert the date 2026-08-31 to DD/MM/YYYY format. Reply with just the formatted date.", "checker": {"kind": "contains", "value": "31/08/2026"}, "tags": ["reasoning"]}',
  '{"id": "sort-numbers", "prompt": "Sort these numbers in ascending order and report them comma-separated: 42, 7, 19, 3", "checker": {"kind": "regex", "value": "3,\\\\s*7,\\\\s*19,\\\\s*42"}, "tags": ["reasoning"]}',
  '{"id": "exec-sha1", "prompt": "Use the shell to compute the SHA-1 hash of the string bitterbot (no trailing newline) and report the first 8 hex characters of the digest.", "checker": {"kind": "contains", "value": "cae65404"}, "tags": ["exec"]}',
  '{"id": "base64-decode", "prompt": "Decode this base64 string and report the plaintext: Y29ycHVzLW9r", "checker": {"kind": "contains", "value": "corpus-ok"}, "tags": ["reasoning", "exec"]}',
  '{"id": "word-extract", "prompt": "What is the 3rd word of this sentence: the quick brown fox jumps. Reply with just the word.", "checker": {"kind": "contains", "value": "brown"}, "tags": ["reasoning"]}',
  '{"id": "unit-convert", "prompt": "Convert 2.5 kilometers to meters. Reply with just the number.", "checker": {"kind": "contains", "value": "2500"}, "tags": ["reasoning"]}',
  '{"id": "multi-step-arith", "prompt": "Compute (12 + 8) * 5, then subtract 1. Reply with just the final number.", "checker": {"kind": "regex", "value": "\\\\b99\\\\b"}, "tags": ["reasoning"]}',
  "",
];

/** SHA-256 of the full corpus bytes (integrity pin; test-enforced). */
export const CANONICAL_CORPUS_SHA256 =
  "4bf377a411d7f82c7985879a024b4384c248d93b0676b22468833de30ea3818c";

/**
 * Corpus version identity recorded with verdicts. The "canonical-" prefix
 * is how consumers (marketplace ranking) recognize a canonical-corpus
 * verdict; the suffix is the same SHA-1[0:12] scheme the grown corpus uses.
 */
export const CANONICAL_CORPUS_VERSION = "canonical-a477c941ebcb";

export function canonicalCorpusRaw(): string {
  return CANONICAL_CORPUS_LINES.join("\n");
}

/**
 * Load the embedded canonical corpus. Fails closed (null + warn) if the
 * embedded bytes do not match the pinned hash — a corrupted or tampered
 * build must not silently become the trust baseline.
 */
export function loadCanonicalCorpus(): TaskCorpus | null {
  const raw = canonicalCorpusRaw();
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (sha256 !== CANONICAL_CORPUS_SHA256) {
    log.warn(
      `canonical corpus integrity check FAILED (got ${sha256.slice(0, 12)}…, pinned ${CANONICAL_CORPUS_SHA256.slice(0, 12)}…); refusing to use it`,
    );
    return null;
  }
  const tasks = parseCorpusTasks(raw);
  if (tasks.length === 0) {
    log.warn("canonical corpus parsed to zero tasks; refusing to use it");
    return null;
  }
  return { tasks, version: CANONICAL_CORPUS_VERSION };
}

/**
 * The corpus a trust decision actually runs on: canonical baseline plus the
 * node's grown corpus (grown tasks whose ids collide with canonical ones
 * are dropped — the baseline is immutable). The grown corpus AUGMENTS but
 * never replaces the canonical baseline (invariant I10 / PLAN-42 §5.7).
 * A brand-new node therefore always has at least the canonical tasks.
 */
export async function loadEffectiveCorpus(
  opts: ImpactTrailOptions = {},
): Promise<TaskCorpus | null> {
  const canonical = loadCanonicalCorpus();
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
  // (Bounding grown weight also limits how far a padded grown corpus can
  // inflate a score that carries the canonical- version prefix.)
  const grownBudget = Math.max(0, MAX_CORPUS_TASKS - canonical.tasks.length);
  const merged = [
    ...canonical.tasks,
    ...grown.tasks.filter((t) => !canonicalIds.has(t.id)).slice(0, grownBudget),
  ];
  return { tasks: merged, version: `${canonical.version}+${grown.version}` };
}
