/**
 * PLAN-45 Phase 1.3: the per-skill evidence record is derived from the
 * read ledger, the lifecycle counters, the evolution meta and the
 * provenance trail; it is the one thing downstream readers consult.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillReadEvent } from "./skill-reads.js";
import {
  buildEvidenceRecord,
  readEvidenceRecords,
  refreshEvidenceRecords,
} from "./evidence-record.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function ev(over: Partial<SkillReadEvent>): SkillReadEvent {
  return {
    runId: "r",
    skill: "acme",
    ts: NOW - DAY,
    success: true,
    label: "pass",
    outcomeLevel: 1,
    model: "anthropic/claude-opus-4-8",
    completedExplicitly: false,
    toolErrors: 0,
    origin: "human",
    sessionKey: "agent:main:main",
    credited: true,
    ...over,
  };
}

describe("buildEvidenceRecord", () => {
  it("counts credited in-window reads by verdict, tracks models, and carries the gate", () => {
    const rec = buildEvidenceRecord({
      name: "acme",
      events: [
        ev({ runId: "r1" }),
        ev({ runId: "r2", label: "fail", success: false, outcomeLevel: 3 }),
        ev({ runId: "r3", label: "env-fail", success: false, model: "openai/gpt-5" }),
        ev({ runId: "r4", credited: false }),
        ev({ runId: "r5", ts: NOW - 40 * DAY }),
        ev({ runId: "r6", skill: "other" }),
      ],
      lifecycle: {
        usageCount: 9,
        successCount: 6,
        errorCount: 2,
        lastUsedAt: NOW - DAY,
        origin: "agent_authored",
      },
      meta: {
        origin: "wiki-evolution",
        validation: {
          mode: "tasks",
          verdict: "accepted",
          pValue: 0.031,
          wins: 5,
          losses: 0,
          trials: 15,
          trialsPerTask: 3,
          corpusVersion: "canonical-g4-s9",
          model: "anthropic/claude-opus-4-8",
          candidateReadRate: { capability: 0.8, regression: 0.1 },
          validatedAt: NOW - 5 * DAY,
        },
        descriptionRepairs: 1,
        published: { at: NOW - DAY },
      } as never,
      provenance: [
        {
          skillName: "acme",
          action: "validate",
          verdict: "rejected",
          score: -0.2,
          detail: "no-improvement",
          timestamp: NOW - 9 * DAY,
        },
        {
          skillName: "acme",
          action: "validate",
          verdict: "accepted",
          score: 0.4,
          timestamp: NOW - 5 * DAY,
        },
        { skillName: "other", action: "validate", verdict: "accepted", timestamp: NOW - 5 * DAY },
      ],
      now: NOW,
    });
    expect(rec.reads).toEqual({
      total: 3,
      runs: 3,
      pass: 1,
      fail: 1,
      indeterminate: 1,
      successRate: 0.5,
      maxEvidenceLevel: 3,
      lastReadAt: NOW - DAY,
    });
    expect(rec.ladder).toBe("validated");
    expect(rec.gate).toMatchObject({ verdict: "accepted", pValue: 0.031, wins: 5, losses: 0 });
    expect(rec.models).toEqual({
      validatedOn: ["anthropic/claude-opus-4-8"],
      readBy: ["anthropic/claude-opus-4-8", "openai/gpt-5"],
    });
    expect(rec.gateHistory.map((g) => g.verdict)).toEqual(["rejected", "accepted"]);
    expect(rec.descriptionRepairs).toBe(1);
    expect(rec.publishedAt).toBe(NOW - DAY);
    expect(rec.lifetime).toMatchObject({ usageCount: 9, successCount: 6, errorCount: 2 });
  });

  it("is unmanaged with no gate for a hand-written skill and a null rate with no determinate reads", () => {
    const rec = buildEvidenceRecord({
      name: "manual",
      events: [ev({ skill: "manual", label: "unknown", success: false })],
      lifecycle: null,
      meta: null,
      provenance: [],
      now: NOW,
    });
    expect(rec.ladder).toBe("unmanaged");
    expect(rec.gate).toBeNull();
    expect(rec.reads.successRate).toBeNull();
    expect(rec.reads.indeterminate).toBe(1);
    expect(rec.origin).toBe("unknown");
  });
});

describe("refreshEvidenceRecords", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-evidence-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("writes .evidence.json into every live skill dir and reads them back", async () => {
    await fs.mkdir(path.join(dir, "skills", "acme"), { recursive: true });
    await fs.mkdir(path.join(dir, "skills", "beta"), { recursive: true });
    await fs.writeFile(path.join(dir, "skills", "acme", "SKILL.md"), "---\nname: acme\n---\n");
    await fs.mkdir(path.join(dir, "skill-wiki"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "skill-wiki", "skill-reads.jsonl"),
      `${JSON.stringify(ev({ runId: "r1" }))}\n${JSON.stringify(ev({ runId: "r2", skill: "beta", label: "fail", success: false }))}\n`,
    );
    const records = await refreshEvidenceRecords({ storeOpts: { configDir: dir }, now: NOW });
    expect(records.map((r) => r.name).toSorted()).toEqual(["acme", "beta"]);
    const onDisk = JSON.parse(
      await fs.readFile(path.join(dir, "skills", "acme", ".evidence.json"), "utf-8"),
    ) as { reads: { pass: number } };
    expect(onDisk.reads.pass).toBe(1);
    const read = await readEvidenceRecords({ configDir: dir });
    expect(read.map((r) => [r.name, r.reads.fail])).toEqual([
      ["acme", 0],
      ["beta", 1],
    ]);
  });
});
