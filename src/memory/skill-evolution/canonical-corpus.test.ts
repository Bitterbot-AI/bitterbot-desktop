/**
 * Corpus/gate upgrade (2026-09-02): the canonical corpus is GENERATOR-
 * SEEDED — template(seed) → (instance, ground truth) — so memorizing any
 * instance (including the public exemplar) buys nothing. These tests hold
 * the three synchronized forms together (generator code, seed-0 exemplar
 * file, SHA-256 pin) and prove generator ground-truth correctness across
 * many seeds.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_EXEMPLAR_SHA256,
  CANONICAL_GENERATOR_VERSION,
  canonicalExemplarJsonl,
  deriveCanonicalSeed,
  generateCanonicalCorpus,
  loadCanonicalCorpus,
  loadEffectiveCorpus,
} from "./canonical-corpus.js";
import { scoreTaskAnswer } from "./task-corpus.js";

const REPO_EXEMPLAR_FILE = fileURLToPath(
  new URL("../../../benchmarks/skill-evolution/canonical-corpus.jsonl", import.meta.url),
);

describe("canonical corpus (generator-seeded)", () => {
  it("seed-0 exemplar is byte-identical to benchmarks/skill-evolution/canonical-corpus.jsonl", async () => {
    const fileRaw = await fs.readFile(REPO_EXEMPLAR_FILE, "utf-8");
    expect(canonicalExemplarJsonl()).toBe(fileRaw);
  });

  it("pinned SHA-256 matches the exemplar (on a template change, set the pin to this value)", () => {
    const sha256 = createHash("sha256").update(canonicalExemplarJsonl()).digest("hex");
    expect(sha256).toBe(CANONICAL_EXEMPLAR_SHA256);
  });

  it("generation is deterministic per seed and varies across seeds", () => {
    const a = generateCanonicalCorpus(7);
    const b = generateCanonicalCorpus(7);
    const c = generateCanonicalCorpus(8);
    expect(JSON.stringify(a.tasks)).toBe(JSON.stringify(b.tasks));
    expect(JSON.stringify(a.tasks)).not.toBe(JSON.stringify(c.tasks));
    expect(a.version).toBe(`canonical-g${CANONICAL_GENERATOR_VERSION}-s7`);
    // Task IDENTITY is stable across seeds (paired comparison needs it).
    expect(a.tasks.map((t) => t.id)).toEqual(c.tasks.map((t) => t.id));
  });

  it("every task is regression-suite with a hardened final checker", () => {
    for (const task of generateCanonicalCorpus(3).tasks) {
      expect(task.suite).toBe("regression");
      expect(task.checker.kind).toBe("final");
      expect(task.prompt).toContain('"FINAL: <answer>"');
    }
  });

  it("generator ground truth is CORRECT across a seed sweep", () => {
    for (let seed = 0; seed < 25; seed++) {
      const byId = new Map(generateCanonicalCorpus(seed).tasks.map((t) => [t.id, t]));

      const arith = byId.get("arith-basic")!;
      const [a, b] = [...arith.prompt.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
      expect(arith.checker.value, arith.prompt).toBe(String(a! * b!));

      const sha = byId.get("exec-sha1")!;
      const shaToken = /the string (\S+) \(no trailing/.exec(sha.prompt)![1]!;
      expect(sha.checker.value).toBe(createHash("sha1").update(shaToken).digest("hex").slice(0, 8));

      const b64 = byId.get("base64-decode")!;
      const encoded = /plaintext: (\S+?)(?:\s|$)/.exec(b64.prompt)![1]!;
      expect(Buffer.from(encoded, "base64").toString("utf-8")).toBe(b64.checker.value);

      const json = byId.get("json-extract")!;
      const parsed = JSON.parse(/(\{.*\})/.exec(json.prompt)![1]!) as { x: string };
      expect(json.checker.value).toBe(parsed.x);

      const vowels = byId.get("vowel-count")!;
      const word = /the word (\w+)\?/.exec(vowels.prompt)![1]!;
      expect(vowels.checker.value).toBe(String((word.match(/[aeiou]/g) ?? []).length));

      const sort = byId.get("sort-numbers")!;
      const nums = /order.*?: ([\d, ]+)\./
        .exec(sort.prompt)![1]!
        .split(",")
        .map((n) => Number(n.trim()));
      expect(sort.checker.value).toBe(nums.toSorted((x, y) => x - y).join(", "));

      const multi = byId.get("multi-step-arith")!;
      const [ma, mb, mc, md] = [...multi.prompt.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
      expect(multi.checker.value).toBe(String((ma! + mb!) * mc! - md!));

      // A correct FINAL-line answer scores 1; the raw value alone scores 0.
      expect(scoreTaskAnswer(arith, `FINAL: ${arith.checker.value}`)).toBe(1);
      expect(scoreTaskAnswer(arith, arith.checker.value)).toBe(0);
    }
  });

  it("deriveCanonicalSeed is deterministic over its parts", () => {
    expect(deriveCanonicalSeed("hash1", "v2")).toBe(deriveCanonicalSeed("hash1", "v2"));
    expect(deriveCanonicalSeed("hash1", "v2")).not.toBe(deriveCanonicalSeed("hash2", "v2"));
  });

  it("effective corpus = seeded canonical baseline on a fresh node", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-fresh-"));
    const corpus = await loadEffectiveCorpus({ configDir }, 42);
    expect(corpus).not.toBeNull();
    expect(corpus!.tasks.length).toBe(12);
    expect(corpus!.version).toBe(`canonical-g${CANONICAL_GENERATOR_VERSION}-s42`);
    expect(loadCanonicalCorpus(42)!.tasks[0]!.prompt).toBe(corpus!.tasks[0]!.prompt);
  });

  it("grown corpus AUGMENTS the baseline (capability by default) and cannot shadow canonical ids", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-grown-"));
    const wikiDir = path.join(configDir, "skill-wiki");
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.writeFile(
      path.join(wikiDir, "task-corpus.jsonl"),
      [
        '{"id": "arith-basic", "prompt": "What is 1+1?", "checker": {"kind": "contains", "value": "2"}}',
        '{"id": "local-task", "prompt": "Say local-ok.", "checker": {"kind": "contains", "value": "local-ok"}}',
        "",
      ].join("\n"),
      "utf-8",
    );
    const corpus = await loadEffectiveCorpus({ configDir }, 5);
    expect(corpus!.tasks.length).toBe(13);
    const arith = corpus!.tasks.find((t) => t.id === "arith-basic")!;
    expect(arith.suite).toBe("regression"); // the canonical one survived
    expect(arith.prompt).not.toContain("1+1");
    const local = corpus!.tasks.find((t) => t.id === "local-task")!;
    expect(local.suite).toBeUndefined(); // grown default = capability at gate time
    expect(corpus!.version.startsWith(`canonical-g${CANONICAL_GENERATOR_VERSION}-s5+`)).toBe(true);
  });

  it("merged corpus respects MAX_CORPUS_TASKS, canonical kept whole", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-cap-"));
    const wikiDir = path.join(configDir, "skill-wiki");
    await fs.mkdir(wikiDir, { recursive: true });
    const grownLines = Array.from(
      { length: 30 },
      (_, i) =>
        `{"id": "grown-${i}", "prompt": "task ${i}", "checker": {"kind": "contains", "value": "ok"}}`,
    );
    await fs.writeFile(
      path.join(wikiDir, "task-corpus.jsonl"),
      `${grownLines.join("\n")}\n`,
      "utf-8",
    );
    const corpus = await loadEffectiveCorpus({ configDir });
    expect(corpus!.tasks.length).toBe(30);
    expect(corpus!.tasks.filter((t) => !t.id.startsWith("grown-")).length).toBe(12);
  });
});
