/**
 * PLAN-59 Phase 2 shadow stage: the surfacing trial never alters a delivery.
 *
 * Two managers on two fresh stores built from the same files, the same
 * findings and the same open brief, one with the trial off and one in shadow,
 * surface through every hooked surface under a frozen clock with hormonal
 * modulation and the recency boost off. What each surface returns must be
 * byte-identical. The off store has only `delivered` rows under the `legacy`
 * arm; the shadow store has eligible, assigned and delivered rows per
 * opportunity under a trial arm. The status block reports the counts and an
 * explicit `memory_search` of a withhold-assigned chunk sets the crossover
 * marker through the real search path.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import { blockIdFor, drawArm } from "./surfacing-trial.js";

/** Deterministic unit vectors from the text so vector ranks are stable across stores. */
function vec(text: string): number[] {
  const h = createHash("sha256").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest();
  const raw = [h[0]! + 1, h[1]! + 1, h[2]! + 1, h[3]! + 1];
  const norm = Math.hypot(...raw);
  return raw.map((x) => x / norm);
}

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async (text: string) => {
        // Proactive recall's vector stage needs the sqlite-vec module, which the
        // test store does not load; a failed query embedding sends it down the
        // keyword-fallback stage (FTS over the same crystal filters) instead.
        if (text.startsWith("[noembed]")) {
          throw new Error("embed unavailable");
        }
        return vec(text);
      },
      embedBatch: async (texts: string[]) => texts.map(vec),
    },
  }),
}));

const notices: Array<{ kind: string; text: string }> = [];
vi.mock("../infra/owner-notify.js", () => ({
  notifyOwner: async (n: { kind: string; text: string }) => {
    notices.push({ kind: n.kind, text: n.text });
    return { pushed: "ui" };
  },
}));

const NOTES = [
  "# build\n\nthe build runs on CI with pnpm and node 22\n\nthe release gate needs markdownlint\n",
  "# people\n\nVictor reviews the memory pull requests on Tuesday\n\nthe wallet code is restricted\n",
  "# infra\n\nthe gateway serves the control UI on port 19001\n\nsqlite-vec must stay external\n",
  "# dreams\n\nthe dream engine runs every two hours and rewrites MEMORY.md\n\ncuriosity targets expire\n",
];

const SEED = "neutrality-seed";
const FIXED_AT = Date.UTC(2026, 9, 1, 0, 0, 0);
const FIXED_NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const HOUR = 3_600_000;

type TrialMode = "off" | "shadow";

const managers: MemoryIndexManager[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  notices.length = 0;
  for (const m of managers.splice(0)) {
    await m.close();
  }
  for (const r of roots.splice(0)) {
    await fs.rm(r, { recursive: true, force: true });
  }
});

type Row = {
  id: number;
  event_id: string;
  kind: string;
  ref_id: string | null;
  arm: string;
  opportunity_id: string | null;
  stage: string;
  outcome: string | null;
  label_provenance: string | null;
  details_json: string | null;
};

const rows = (file: string, where = "1 = 1"): Row[] => {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare(`SELECT * FROM surfacing_events WHERE ${where} ORDER BY id`)
      .all() as unknown as Row[];
  } finally {
    db.close();
  }
};

async function openManager(trialMode: TrialMode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `bitterbot-surfacing-${trialMode}-`));
  roots.push(root);
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  for (let i = 0; i < NOTES.length; i++) {
    await fs.writeFile(path.join(workspaceDir, "memory", `note-${i}.md`), NOTES[i]!);
  }
  const indexPath = path.join(root, "index.sqlite");
  const cfg = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath, vector: { enabled: true } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          cache: { enabled: false },
          query: {
            minScore: 0,
            hybrid: { enabled: true, mergeStrategy: "rrf" },
            // Recency measures from access counters every search advances.
            recency: { enabled: false },
          },
        },
      },
      list: [{ id: "main", default: true }],
    },
    memory: {
      dream: { enabled: false },
      consolidation: { enabled: false },
      // Hormonal state would scale the mood and recency boosts per manager.
      emotional: { enabled: false, hormonal: { enabled: false } },
      coverageDiagnostics: { enabled: false },
      curiosity: {
        evidence: { mode: "shadow", surfacingTrial: { mode: trialMode, seed: SEED } },
      },
    },
  };
  const { manager } = await getMemorySearchManager({ cfg, agentId: "main" });
  if (!manager) {
    throw new Error("manager missing");
  }
  managers.push(manager);
  await manager.sync({ reason: "test" });
  const db = (manager as unknown as { db: DatabaseSync }).db;
  // Pin every chunk to one timestamp and make the notes recall-eligible
  // crystals (proactive recall reads directive/world_fact/mental_model layers).
  db.exec(
    `UPDATE chunks SET created_at = ${FIXED_AT}, updated_at = ${FIXED_AT}, last_accessed_at = NULL,
       epistemic_layer = 'world_fact', importance_score = 0.9`,
  );
  // The same two findings and one open anticipation brief in both stores.
  db.prepare(
    `INSERT INTO research_findings (id, target_id, finding, source_url, relevance, created_at)
     VALUES ('rf-1', 'target-1', 'node 22 is the CI runtime', 'https://example.test/a', 0.9, ?),
            ('rf-2', 'target-2', 'markdownlint gates the release', NULL, 0.8, ?)`,
  ).run(FIXED_AT + 1000, FIXED_AT + 2000);
  db.prepare(
    `INSERT INTO dream_briefs (id, context_kind, context_ref, question, answer_sketch, created_at)
     VALUES ('brief-1', 'session', NULL, 'will the release gate change?', 'markdownlint stays', ?)`,
  ).run(FIXED_AT + 3000);
  return { manager, indexPath, db };
}

describe("surfacing trial is neutral to every hooked surface (PLAN-59 Phase 2 shadow)", () => {
  it("delivers byte-identical content in off and shadow mode and logs eligible, assigned, delivered only in shadow", async () => {
    const off = await openManager("off");
    const shadow = await openManager("shadow");
    const clock = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);

    // curiosity_finding
    const findingsOff = off.manager.consumeResearchFindings(3);
    const findingsShadow = shadow.manager.consumeResearchFindings(3);
    expect(findingsOff.length).toBe(2);
    expect(JSON.stringify(findingsShadow)).toBe(JSON.stringify(findingsOff));

    // dream_brief
    const briefOff = off.manager.consumeDreamBrief();
    const briefShadow = shadow.manager.consumeDreamBrief();
    expect(briefOff).not.toBeNull();
    expect(JSON.stringify(briefShadow)).toBe(JSON.stringify(briefOff));

    // proactive_recall
    const recallOff = await off.manager.recallForUserTurn(
      "[noembed] markdownlint release gate pnpm",
      {
        scopeKey: "agent:main:s1",
      },
    );
    const recallShadow = await shadow.manager.recallForUserTurn(
      "[noembed] markdownlint release gate pnpm",
      { scopeKey: "agent:main:s1" },
    );
    expect(recallOff.facts).toBeTruthy();
    expect(recallShadow.facts).toBe(recallOff.facts);
    // Selection is not exposure: the full prompt renderer acknowledges the
    // facts it included, with the turn's stable id, and only then is the
    // opportunity logged (Phase 0 correction).
    const delivery = { id: "run-1", sessionKey: "agent:main:s1" };
    off.manager.recordProactiveRecallDelivery(recallOff.renderedChunkIds ?? [], delivery);
    shadow.manager.recordProactiveRecallDelivery(recallShadow.renderedChunkIds ?? [], delivery);

    // dream_digest (forced: the stores have no dream cycles to make it worth sending)
    const digestOff = await off.manager.sendDreamBrief({ force: true });
    const digestShadow = await shadow.manager.sendDreamBrief({ force: true });
    expect(digestOff).toBeTruthy();
    expect(digestShadow).toBe(digestOff);
    expect(notices.map((n) => n.text)).toEqual([digestOff, digestOff]);
    clock.mockRestore();

    // off: delivered rows only, legacy arm, one per item
    const offRows = rows(off.indexPath);
    expect(offRows.length).toBeGreaterThanOrEqual(4);
    expect(new Set(offRows.map((r) => r.stage))).toEqual(new Set(["delivered"]));
    expect(new Set(offRows.map((r) => r.arm))).toEqual(new Set(["legacy"]));
    expect(off.manager.getSurfacingTrial()?.isActive()).toBe(false);

    // shadow: the same deliveries, each preceded by eligible and assigned
    const shadowRows = rows(shadow.indexPath);
    const delivered = shadowRows.filter((r) => r.stage === "delivered");
    expect(delivered.map((r) => `${r.kind}:${r.ref_id}`)).toEqual(
      offRows.map((r) => `${r.kind}:${r.ref_id}`),
    );
    expect(new Set(delivered.map((r) => r.kind))).toEqual(
      new Set(["curiosity_finding", "dream_brief", "proactive_recall", "dream_digest"]),
    );
    for (const d of delivered) {
      expect(["surface", "withhold"]).toContain(d.arm);
      const eligible = shadowRows.find(
        (r) => r.stage === "eligible" && r.opportunity_id === d.opportunity_id,
      );
      const assigned = shadowRows.find(
        (r) => r.stage === "assigned" && r.opportunity_id === d.opportunity_id,
      );
      expect(eligible, `eligible for ${d.event_id}`).toBeDefined();
      expect(assigned, `assigned for ${d.event_id}`).toBeDefined();
      expect(eligible!.id).toBeLessThan(assigned!.id);
      expect(assigned!.id).toBeLessThan(d.id);
      expect(eligible!.arm).toBe("unassigned");
      expect(assigned!.arm).toBe(d.arm);
      expect(eligible!.kind).toBe(d.kind);
      expect(eligible!.ref_id).toBe(d.ref_id);
      expect(assigned!.ref_id).toBe(d.ref_id);
      expect(assigned!.event_id).toBe(`assigned:${d.event_id}`);
      expect(eligible!.event_id).toBe(`eligible:${d.event_id}`);
      const details = JSON.parse(assigned!.details_json!) as {
        blockId: number;
        carryOver: boolean;
      };
      expect(details.blockId).toBe(blockIdFor(FIXED_NOW, 240));
      expect(details.carryOver).toBe(false);
      // the arm is the deterministic draw for (kind, block) under the configured seed
      expect(d.arm).toBe(drawArm(SEED, d.kind, blockIdFor(FIXED_NOW, 240)));
    }
    // findings keep their target as the opportunity id so a dismiss still finds them
    const finding = delivered.find((r) => r.ref_id === "rf-1")!;
    expect(finding.opportunity_id).toBe("target-1");
    expect(shadowRows.filter((r) => r.stage === "eligible")).toHaveLength(delivered.length);
    expect(shadowRows.filter((r) => r.stage === "assigned")).toHaveLength(delivered.length);
    // nothing carries an outcome yet: silence is unknown
    expect(shadowRows.every((r) => r.outcome === null)).toBe(true);

    // the dismiss RPC path labels the delivered finding under its trial arm
    await shadow.manager.curiosityDismiss("target-1");
    const labelled = rows(shadow.indexPath, "outcome IS NOT NULL");
    expect(labelled).toHaveLength(1);
    expect(labelled[0]).toMatchObject({
      event_id: finding.event_id,
      stage: "delivered",
      arm: finding.arm,
      outcome: "dismissed",
      label_provenance: "explicit",
    });

    // status reports the trial block from the same counts
    const status = (await shadow.manager.curiosityStatus()) as {
      evidence: {
        surfacingEvents: number;
        surfacingTrial: {
          mode: string;
          blocks: number;
          balance: number | null;
          byKind: Record<string, { eligible: number; assigned: number; delivered: number }>;
        };
      };
    };
    expect(status.evidence.surfacingEvents).toBe(shadowRows.length);
    expect(status.evidence.surfacingTrial).toEqual(shadow.manager.getSurfacingTrial()!.stats());
    expect(status.evidence.surfacingTrial.mode).toBe("shadow");
    expect(status.evidence.surfacingTrial.blocks).toBe(1);
    for (const kind of ["curiosity_finding", "dream_brief", "proactive_recall", "dream_digest"]) {
      const n = delivered.filter((r) => r.kind === kind).length;
      expect(status.evidence.surfacingTrial.byKind[kind]).toMatchObject({
        eligible: n,
        assigned: n,
        delivered: n,
      });
    }
    const withhold = delivered.filter((r) => r.arm === "withhold").length;
    expect(status.evidence.surfacingTrial.balance).toBe(withhold / delivered.length);
    const offStatus = (await off.manager.curiosityStatus()) as {
      evidence: { surfacingTrial: { mode: string; active: boolean; balance: number | null } };
    };
    expect(offStatus.evidence.surfacingTrial).toMatchObject({
      mode: "off",
      active: false,
      balance: null,
    });
  });

  it("an explicit memory_search of a withhold-assigned chunk sets the crossover marker through the real search path", async () => {
    const shadow = await openManager("shadow");
    const trial = shadow.manager.getSurfacingTrial()!;
    expect(trial.isActive()).toBe(true);
    const chunk = shadow.db
      .prepare(`SELECT id FROM chunks WHERE text LIKE '%pnpm%' LIMIT 1`)
      .get() as { id: string };
    const other = shadow.db
      .prepare(`SELECT id FROM chunks WHERE text LIKE '%19001%' LIMIT 1`)
      .get() as { id: string };
    expect(chunk?.id).toBeTruthy();
    expect(other?.id).toBeTruthy();
    // a recent withhold block (inside the 7-day carry-over window from the real clock)
    const realNow = Date.now();
    let tW = -1;
    for (let i = 1; i < 40; i++) {
      const t = realNow - i * 4 * HOUR;
      if (drawArm(SEED, "proactive_recall", blockIdFor(t, 240)) === "withhold") {
        tW = t;
        break;
      }
    }
    expect(tW).toBeGreaterThan(0);
    const a = trial.surface({
      eventId: `pr:${chunk.id}:${Math.floor(tW / HOUR)}`,
      kind: "proactive_recall",
      refId: chunk.id,
      now: tW,
    });
    const b = trial.surface({
      eventId: `pr:${other.id}:${Math.floor(tW / HOUR)}`,
      kind: "proactive_recall",
      refId: other.id,
      now: tW,
    });
    expect(a.arm).toBe("withhold");
    expect(b.arm).toBe("withhold");

    // a non-explicit caller returning the chunk leaves it alone
    const sweep = await shadow.manager.search("build CI pnpm", {
      maxResults: 5,
      caller: "deep_recall",
    });
    expect(sweep.length).toBeGreaterThan(0);
    expect(rows(shadow.indexPath, "outcome IS NOT NULL")).toHaveLength(0);

    // the owner's explicit search labels the opportunities whose chunks it returned
    const explicit = await shadow.manager.search("build CI pnpm", {
      maxResults: 5,
      caller: "memory_search",
    });
    expect(explicit.length).toBeGreaterThan(0);
    const returnedIds = new Set(
      explicit.map(
        (r) =>
          (
            shadow.db
              .prepare(`SELECT id FROM chunks WHERE path = ? AND start_line = ? AND end_line = ?`)
              .get(r.path, r.startLine, r.endLine) as { id: string } | undefined
          )?.id,
      ),
    );
    expect(returnedIds.has(chunk.id)).toBe(true);
    const labelled = rows(shadow.indexPath, "outcome IS NOT NULL");
    expect(labelled.length).toBeGreaterThanOrEqual(1);
    expect(labelled.map((r) => r.ref_id)).toContain(chunk.id);
    for (const r of labelled) {
      expect(r).toMatchObject({
        stage: "delivered",
        arm: "withhold",
        outcome: "explicit_retrieval",
        label_provenance: "shadow_crossover",
      });
      expect(returnedIds.has(r.ref_id!)).toBe(true);
    }
    expect(trial.stats().byKind.proactive_recall.crossover).toBe(labelled.length);
  });
});
