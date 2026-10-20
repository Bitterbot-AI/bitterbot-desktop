/**
 * PLAN-45 5.3: two-node transfer end to end, asserted on disk artifacts.
 *
 * Node A (an explicit configDir) evolves a skill: gate accept -> canary ->
 * monitor graduates it -> publish sweep signs the trailer with A's device
 * key and hands the body to a publisher. The test signs the envelope with
 * A's node key exactly as the orchestrator would. Node B (the process
 * CONFIG_DIR, pointed at a temp dir before any module loads) ingests it:
 * quarantine with the verified binding -> operator accept lands in staging
 * (never live) -> B's gate measures it on B's private suite -> strict
 * canary (A's evolver model is weaker than B's primary) -> monitor
 * graduates it -> stable, with A's key on the provenance and B's own
 * attestation stored.
 */

import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readCanaryRegistry,
  resetCanaryRegistryCacheForTest,
} from "../../src/agents/skills/canary-registry.js";
import { readProvenance } from "../../src/agents/skills/impact-trail.js";
import { acceptIncomingSkill, ingestSkill } from "../../src/agents/skills/ingest.js";
import {
  readLive,
  readStaged,
  resolveStorageRoots,
} from "../../src/agents/skills/skill-storage.js";
import { generateKeyPair, pubkeyId } from "../../src/commerce/envelope.js";
import { ensureMemoryIndexSchema } from "../../src/memory/memory-schema.js";
import { runMigrations } from "../../src/memory/migrations.js";
import { listAttestations } from "../../src/memory/skill-evolution/attestation.js";
import { appendCanaryRuns } from "../../src/memory/skill-evolution/canary-ledger.js";
import { runCanaryMonitor } from "../../src/memory/skill-evolution/canary-monitor.js";
import { publishEligibleEvolvedSkills } from "../../src/memory/skill-evolution/p2p-publish.js";
import { applyProposal } from "../../src/memory/skill-evolution/proposal-apply.js";
import { corpusPath } from "../../src/memory/skill-evolution/task-corpus.js";
import { runValidationGate } from "../../src/memory/skill-evolution/validation-gate.js";
import { CONFIG_DIR } from "../../src/utils.js";

// Node B is the process state dir: the test setup already points it at a
// temp home, so ingest's CONFIG_DIR-rooted paths land there.
const nodeB = CONFIG_DIR;

const DAY = 24 * 60 * 60 * 1000;
const NAME = "curl-timeout-guard";
const SKILL_MD =
  "---\nname: curl-timeout-guard\ndescription: Bound every curl in exec with --max-time when the task runs curl; not for commands that make no network calls.\n---\n\n## When to Apply\nAny exec call invoking curl.\n\n## When NOT to Apply\nNon-network commands.\n\nAlways pass --max-time 30.";

async function growCorpus(configDir: string, n: number): Promise<void> {
  await fs.mkdir(path.dirname(corpusPath({ configDir })), { recursive: true });
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      id: `grown-${i}`,
      prompt: `grown task ${i}. Reply FINAL: <answer>.`,
      checker: { kind: "final", value: "PASS" },
      suite: "capability",
    }),
  );
  await fs.writeFile(corpusPath({ configDir }), `${lines.join("\n")}\n`, "utf-8");
}

const oracleRunner = async (
  task: { suite?: string; checker: { value: string } },
  variant: string,
) =>
  task.suite === "regression"
    ? { answer: "FINAL: x", skillRead: false }
    : {
        answer: variant === "candidate" ? `FINAL: ${task.checker.value}` : "FINAL: nope",
        skillRead: variant === "candidate",
      };

/** Rows stamped AFTER the canary started (the monitor windows by startedAt). */
function canaryRows(skill: string, n: number, base: number) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    for (const exposed of [true, false]) {
      rows.push({
        runId: `${skill}-${exposed ? "e" : "u"}${i}`,
        skill,
        ts: base + i * 1000,
        exposed,
        read: exposed && i % 2 === 0,
        eligible: true,
        label: "pass",
        outcomeLevel: 2,
        model: "m",
        origin: "human",
        credited: true,
        sessionKey: "agent:main:main",
      });
    }
  }
  return rows;
}

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({ db, embeddingCacheTable: "embedding_cache", ftsTable: "chunks_fts" });
  runMigrations(db);
  return db;
}

describe("PLAN-45 5.3: two-node transfer", () => {
  let nodeA: string;
  beforeAll(async () => {
    nodeA = await fs.mkdtemp(path.join(os.tmpdir(), "node-a-"));
    resetCanaryRegistryCacheForTest();
  });
  afterAll(async () => {
    await fs.rm(nodeA, { recursive: true, force: true });
    for (const sub of [
      "skills",
      "skills-staging",
      "skills-incoming",
      "skills-archive",
      "skill-wiki",
    ]) {
      await fs.rm(path.join(nodeB, sub), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("publish -> quarantine -> accept (staged) -> re-gate -> strict canary -> stable", async () => {
    // ── Node A: evolve, gate, canary, graduate ────────────────────────────
    await applyProposal(
      { action: "create", name: NAME, skillMd: SKILL_MD, purposeMd: "# Purpose\n" },
      {
        storeOpts: { configDir: nodeA },
        iteration: "a-1",
        evidence: { runIds: ["r1"], origins: ["human"] },
      },
    );
    await growCorpus(nodeA, 5);
    const gateA = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: nodeA },
      runTask: oracleRunner,
      trialsPerTask: 1,
      modelTag: "anthropic/claude-haiku-4-5",
      evolverModelTag: "anthropic/claude-haiku-4-5",
    });
    expect(gateA[0]?.outcome).toBe("promoted");
    const rootsA = resolveStorageRoots({ configDir: nodeA });
    const metaA = () =>
      fs.readFile(path.join(rootsA.liveRoot, NAME, ".evolution-meta.json"), "utf-8").then(
        (r) =>
          JSON.parse(r) as {
            ladder?: { state: string };
            validation?: { evolverModel?: string };
            published?: { contentHash: string };
          },
      );
    expect((await metaA()).ladder?.state).toBe("canary");
    // A's canary window: 20 eligible exposures, reads, no regression -> stable.
    const regA = await readCanaryRegistry({ configDir: nodeA });
    await appendCanaryRuns(canaryRows(NAME, 20, Date.now() + 1000), { configDir: nodeA });
    const monA = await runCanaryMonitor({
      storeOpts: { configDir: nodeA },
      now: Date.now() + 15 * DAY,
    });
    expect(monA.actions).toEqual([
      expect.objectContaining({ skillName: NAME, action: "graduated" }),
    ]);
    expect((await metaA()).ladder?.state).toBe("stable");
    expect(regA.skills[NAME]).toBeDefined();
    expect((await readCanaryRegistry({ configDir: nodeA })).skills[NAME]).toBeUndefined();

    // ── Node A: publish with a signed trailer ─────────────────────────────
    const deviceA = generateKeyPair();
    const nodeKeyA = generateKeyPairSync("ed25519");
    const nodePubkeyA = (nodeKeyA.publicKey.export({ format: "der", type: "spki" }) as Buffer)
      .subarray(-32)
      .toString("base64");
    const published: Array<{ name: string; body: string }> = [];
    const sweep = await publishEligibleEvolvedSkills({
      publisher: {
        publishSkill: async (b64, name) => {
          published.push({ name, body: Buffer.from(b64, "base64").toString("utf-8") });
          return {
            content_hash: createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex"),
          };
        },
      },
      storeOpts: { configDir: nodeA },
      maturityDays: 0,
      now: Date.now() + 15 * DAY,
      signing: { key: deviceA, nodePubkey: nodePubkeyA },
    });
    expect(sweep.published).toEqual([NAME]);
    const wire = published[0]!.body;
    expect(wire).toContain("wiki-evolution-provenance");
    expect(wire).toContain('"evolverModel":"anthropic/claude-haiku-4-5"');
    expect(wire).toContain(`"attesterPubkey":"${pubkeyId(deviceA)}"`);
    expect((await metaA()).published?.contentHash).toHaveLength(64);

    // ── The mesh: the orchestrator signs the wire bytes with the node key ──
    const bytes = Buffer.from(wire, "utf-8");
    const envelope = {
      version: 1,
      skill_md: bytes.toString("base64"),
      name: NAME,
      author_peer_id: "12D3KooWNodeA",
      author_pubkey: nodePubkeyA,
      signature: cryptoSign(null, bytes, nodeKeyA.privateKey).toString("base64"),
      timestamp: Date.now(),
      content_hash: createHash("sha256").update(bytes).digest("hex"),
    };
    expect(envelope.content_hash).toBe((await metaA()).published?.contentHash);

    // ── Node B: ingest, review, accept into staging ───────────────────────
    const cfgB = {
      skills: {
        p2p: { ingestPolicy: "review", quarantineDir: path.join(nodeB, "skills-incoming") },
      },
    } as never;
    const received = await ingestSkill({ envelope, config: cfgB });
    expect(received.action).toBe("quarantined");
    const envB = JSON.parse(
      await fs.readFile(path.join(nodeB, "skills-incoming", NAME, ".envelope.json"), "utf-8"),
    ) as { evolution_provenance?: { evolverModel?: string; binding?: { nodePubkey: string } } };
    expect(envB.evolution_provenance?.evolverModel).toBe("anthropic/claude-haiku-4-5");
    expect(envB.evolution_provenance?.binding?.nodePubkey).toBe(nodePubkeyA);
    const accepted = await acceptIncomingSkill({ skillName: NAME, config: cfgB });
    expect(accepted).toMatchObject({ ok: true, action: "staged" });
    const rootsB = resolveStorageRoots();
    expect(rootsB.liveRoot).toBe(path.join(nodeB, "skills"));
    expect(await readLive(rootsB, NAME)).toBeNull();
    expect((await readStaged(rootsB, NAME))?.meta.author).toBe("peer");

    // ── Node B: re-gate on B's private suite, strict canary ───────────────
    const dbB = newDb();
    const deviceB = generateKeyPair();
    const heldB = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: nodeB },
      runTask: oracleRunner,
      trialsPerTask: 1,
      modelTag: "anthropic/claude-opus-5",
      attestKeyPair: deviceB,
      db: dbB,
    });
    expect(heldB[0]?.detail).toContain("no-private-suite");
    await growCorpus(nodeB, 5);
    const gateB = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: nodeB },
      runTask: oracleRunner,
      trialsPerTask: 1,
      modelTag: "anthropic/claude-opus-5",
      attestKeyPair: deviceB,
      db: dbB,
    });
    expect(gateB[0]?.outcome).toBe("promoted");
    expect(await readLive(rootsB, NAME)).toBe(wire);
    const metaB = JSON.parse(
      await fs.readFile(path.join(rootsB.liveRoot, NAME, ".evolution-meta.json"), "utf-8"),
    ) as {
      origin: string;
      ladder?: { state: string };
      canary?: { bucketFraction: number };
      peer?: { transfer?: { direction: string } };
    };
    expect(metaB.origin).toBe("peer");
    expect(metaB.ladder?.state).toBe("canary");
    // Haiku-evolved, Opus-received: weaker-to-stronger, but the sender's
    // attester is not trusted here, so the window is strict either way.
    expect(metaB.peer?.transfer?.direction).toBe("weaker-to-stronger");
    expect(metaB.canary?.bucketFraction).toBe(0.2);
    const provB = JSON.parse(
      await fs.readFile(path.join(rootsB.liveRoot, NAME, ".provenance.json"), "utf-8"),
    ) as { author_pubkey: string; accepted_by?: string };
    expect(provB.author_pubkey).toBe(nodePubkeyA);
    expect(provB.accepted_by).toBe("operator");
    const regB = await readCanaryRegistry({ configDir: nodeB });
    expect(regB.skills[NAME]).toMatchObject({ bucketFraction: 0.2, reason: "transfer" });
    expect(regB.skills[NAME]?.strict?.minExposed).toBe(16);
    // B's own attestation of the bytes it measured.
    const sha = createHash("sha256").update(Buffer.from(wire, "utf-8")).digest("hex");
    const atts = listAttestations(dbB, sha);
    expect(atts.map((a) => [a.attester_pubkey, a.verdict])).toEqual([
      [pubkeyId(deviceB), "accepted"],
    ]);

    // ── Node B: strict window, then stable ────────────────────────────────
    await appendCanaryRuns(canaryRows(NAME, 40, Date.now() + 1000), { configDir: nodeB });
    const monB = await runCanaryMonitor({
      storeOpts: { configDir: nodeB },
      now: Date.now() + 22 * DAY,
    });
    expect(monB.actions).toEqual([
      expect.objectContaining({ skillName: NAME, action: "graduated" }),
    ]);
    const finalB = JSON.parse(
      await fs.readFile(path.join(rootsB.liveRoot, NAME, ".evolution-meta.json"), "utf-8"),
    ) as { ladder?: { state: string } };
    expect(finalB.ladder?.state).toBe("stable");
    expect((await readCanaryRegistry({ configDir: nodeB })).skills[NAME]).toBeUndefined();
    const trailB = await readProvenance({ configDir: nodeB });
    expect(trailB.map((t) => t.action)).toEqual(expect.arrayContaining(["validate", "graduate"]));
    // A peer skill never republishes from B.
    const sweepB = await publishEligibleEvolvedSkills({
      publisher: { publishSkill: async () => ({}) },
      storeOpts: { configDir: nodeB },
      maturityDays: 0,
      now: Date.now() + 60 * DAY,
    });
    expect(sweepB.eligible).toBe(0);
  });
});
