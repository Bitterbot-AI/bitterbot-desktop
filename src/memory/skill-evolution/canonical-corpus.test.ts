/**
 * PLAN-43 Phase 0 / PLAN-42 §5.7: the canonical base corpus.
 *
 * The corpus has three synchronized forms: the repo file
 * benchmarks/skill-evolution/canonical-corpus.jsonl, the embedded copy in
 * canonical-corpus.ts, and the pinned SHA-256/version constants. These
 * tests hold all three together; on a corpus update they print the new
 * expected pins.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_CORPUS_SHA256,
  CANONICAL_CORPUS_VERSION,
  canonicalCorpusRaw,
  loadCanonicalCorpus,
  loadEffectiveCorpus,
} from "./canonical-corpus.js";

const REPO_CORPUS_FILE = fileURLToPath(
  new URL("../../../benchmarks/skill-evolution/canonical-corpus.jsonl", import.meta.url),
);

describe("canonical corpus", () => {
  it("embedded copy is byte-identical to benchmarks/skill-evolution/canonical-corpus.jsonl", async () => {
    const fileRaw = await fs.readFile(REPO_CORPUS_FILE, "utf-8");
    expect(canonicalCorpusRaw()).toBe(fileRaw);
  });

  it("pinned SHA-256 and version match the content", () => {
    const raw = canonicalCorpusRaw();
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const sha1_12 = createHash("sha1").update(raw).digest("hex").slice(0, 12);
    // On a corpus update, set the pins to these values:
    expect(sha256).toBe(CANONICAL_CORPUS_SHA256);
    expect(`canonical-${sha1_12}`).toBe(CANONICAL_CORPUS_VERSION);
  });

  it("loads with all tasks, deterministic checkers only", () => {
    const corpus = loadCanonicalCorpus();
    expect(corpus).not.toBeNull();
    expect(corpus!.tasks.length).toBe(12);
    expect(corpus!.version).toBe(CANONICAL_CORPUS_VERSION);
    for (const task of corpus!.tasks) {
      expect(["contains", "regex", "exact"]).toContain(task.checker.kind);
      expect(task.checker.value.length).toBeGreaterThan(0);
    }
  });

  it("effective corpus = canonical baseline on a fresh node (bootstrap fix)", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-fresh-"));
    const corpus = await loadEffectiveCorpus({ configDir });
    expect(corpus).not.toBeNull();
    expect(corpus!.tasks.length).toBe(12);
    expect(corpus!.version).toBe(CANONICAL_CORPUS_VERSION);
  });

  it("grown corpus AUGMENTS the canonical baseline and cannot shadow its ids", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-grown-"));
    const wikiDir = path.join(configDir, "skill-wiki");
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.writeFile(
      path.join(wikiDir, "task-corpus.jsonl"),
      [
        // Attempts to replace a canonical task in-place must be ignored.
        '{"id": "arith-basic", "prompt": "What is 1+1?", "checker": {"kind": "contains", "value": "2"}}',
        '{"id": "local-task", "prompt": "Say local-ok.", "checker": {"kind": "contains", "value": "local-ok"}}',
        "",
      ].join("\n"),
      "utf-8",
    );

    const corpus = await loadEffectiveCorpus({ configDir });
    expect(corpus).not.toBeNull();
    expect(corpus!.tasks.length).toBe(13);
    const arith = corpus!.tasks.find((t) => t.id === "arith-basic");
    expect(arith!.prompt).toContain("17 * 23");
    expect(corpus!.tasks.some((t) => t.id === "local-task")).toBe(true);
    expect(corpus!.version.startsWith(`${CANONICAL_CORPUS_VERSION}+`)).toBe(true);
  });

  it("merged corpus respects MAX_CORPUS_TASKS, canonical always kept whole", async () => {
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
    expect(corpus).not.toBeNull();
    expect(corpus!.tasks.length).toBe(30);
    // All 12 canonical tasks survive; grown tasks fill the remainder.
    expect(corpus!.tasks.filter((t) => !t.id.startsWith("grown-")).length).toBe(12);
    expect(corpus!.tasks.filter((t) => t.id.startsWith("grown-")).length).toBe(18);
  });
});
