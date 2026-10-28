import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillEnvelope } from "../agents/skills/ingest.js";
import type { CuriosityEngine } from "./curiosity-engine.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { SkillNetworkBridge } from "./skill-network-bridge.js";
import type { SkillVerifier } from "./skill-verifier.js";

// Fail-closed gates on both halves of the crystal bridge:
// - inbound: an envelope failing Ed25519 + SHA-256 is rejected BEFORE dedup,
//   version resolution or the chunk store see it;
// - outbound: every selector (direct publish, manual content publish,
//   auto-publish on crystallize, query responses) runs through
//   publishCrystalSkill, which refuses when the verifier or tracker is missing,
//   when metrics are non-finite, when the crystal is archived, or when the
//   chunk is not an active skill crystal at all.

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

const content =
  "---\nname: gate-fixture\ndescription: Verify completion\n---\nCheck the expected result before completing a task.";

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureColumn(db, "chunks", "publish_visibility", "TEXT");
  ensureColumn(db, "chunks", "published_at", "INTEGER");
  const publications: Array<{ name: string }> = [];
  const bridge = new SkillNetworkBridge(db, {
    publishSkill: async (_bytes: string, name: string) => {
      publications.push({ name });
      return { ok: true, content_hash: "fixture", delivered_to: 2 };
    },
  });
  bridge.setCuriosityEngine({
    matchQuery: () => [{ id: "fixture" }],
  } as unknown as CuriosityEngine);
  return { db, bridge, publications };
}

function envelope(): SkillEnvelope {
  const keys = generateKeyPairSync("ed25519");
  return {
    version: 1,
    name: "gate-fixture",
    author_peer_id: "fixture",
    timestamp: Date.now(),
    skill_md: Buffer.from(content).toString("base64"),
    content_hash: createHash("sha256").update(content).digest("hex"),
    author_pubkey: keys.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
    signature: sign(null, Buffer.from(content), keys.privateKey).toString("base64"),
  };
}

function setupPublication(
  f: ReturnType<typeof fixture>,
  metrics: { totalExecutions: number; successRate: number } = {
    totalExecutions: 3,
    successRate: 1,
  },
  chunk: { semanticType?: string; lifecycleState?: string } = {},
) {
  f.bridge.setSkillVerifier({ verify: () => ({ passed: true }) } as unknown as SkillVerifier);
  f.bridge.setExecutionTracker({
    getSkillMetrics: () => metrics,
  } as unknown as SkillExecutionTracker);
  f.db
    .prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
         updated_at, semantic_type, lifecycle_state, governance_json)
       VALUES ('fixture', 'skills/fixture', 'skill', 1, 1, 'h', 'fixture', ?, '[]', 1, ?, ?, ?)`,
    )
    .run(
      content,
      chunk.semanticType ?? "skill",
      chunk.lifecycleState ?? "active",
      JSON.stringify({ accessScope: "shared", sensitivity: "normal" }),
    );
}

describe("ingestNetworkSkill authenticity gate", () => {
  it.each(["signature", "hash", "content"])("rejects a tampered %s before storage", (part) => {
    const f = fixture();
    const e = envelope();
    if (part === "signature") {
      e.signature = Buffer.alloc(64).toString("base64");
    }
    if (part === "hash") {
      e.content_hash = "a".repeat(64);
    }
    if (part === "content") {
      e.skill_md = Buffer.from(content + "changed").toString("base64");
    }
    const result = f.bridge.ingestNetworkSkill(e);
    expect(result.action).toBe("rejected");
    expect(result.reason).toBe(
      part === "hash" ? "content hash mismatch" : "invalid Ed25519 signature",
    );
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: 0 });
  });

  it("rejects a wrong-length public key without throwing", () => {
    const f = fixture();
    const e = envelope();
    e.author_pubkey = Buffer.alloc(31).toString("base64");
    expect(f.bridge.ingestNetworkSkill(e)).toMatchObject({
      action: "rejected",
      reason: "invalid Ed25519 signature",
    });
  });

  it("accepts authentic native-format content once, then dedupes it", () => {
    const f = fixture();
    const e = envelope();
    expect(f.bridge.ingestNetworkSkill(e).action).toBe("accepted");
    expect(f.bridge.ingestNetworkSkill(e)).toMatchObject({
      action: "rejected",
      reason: "duplicate content",
    });
  });
});

describe("outbound publish gate", () => {
  it.each(["both", "tracker", "verifier", "nan-rate", "nan-count", "rate>1"])(
    "blocks missing or invalid evidence (%s) on every outbound selector",
    async (mode) => {
      const f = fixture();
      const metrics =
        mode === "nan-rate"
          ? { totalExecutions: 3, successRate: NaN }
          : mode === "nan-count"
            ? { totalExecutions: Number.POSITIVE_INFINITY, successRate: 1 }
            : mode === "rate>1"
              ? { totalExecutions: 3, successRate: 1.5 }
              : { totalExecutions: 3, successRate: 1 };
      setupPublication(f, metrics);
      if (mode === "both" || mode === "tracker") {
        f.bridge.setExecutionTracker(null);
      }
      if (mode === "both" || mode === "verifier") {
        f.bridge.setSkillVerifier(null);
      }
      expect(await f.bridge.publishCrystalSkill("fixture")).toBeNull();
      expect(await f.bridge.publishSkillContent(content)).toBeNull();
      f.bridge.onSkillCrystallized("fixture");
      await f.bridge.handleQueryEvent({ query_id: "q", query: "fixture", author_peer_id: "peer" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.publications).toHaveLength(0);
    },
  );

  it("publishes mature content via direct, manual-content and query selectors", async () => {
    const f = fixture();
    setupPublication(f);
    const direct = await f.bridge.publishCrystalSkill("fixture");
    expect(direct).toMatchObject({ crystalId: "fixture", contentHash: "fixture", deliveredTo: 2 });
    expect((await f.bridge.publishSkillContent(content))?.crystalId).toBe("fixture");
    await f.bridge.handleQueryEvent({
      query_id: "abcdef0123",
      query: "fixture",
      author_peer_id: "peer",
    });
    expect(f.publications.map((p) => p.name)).toEqual([
      "fixture",
      "fixture",
      "response-abcdef01-fixture",
    ]);
  });

  it("refuses manual content that does not byte-match an active crystal", async () => {
    const f = fixture();
    setupPublication(f);
    expect(await f.bridge.publishSkillContent(content + "changed")).toBeNull();
    expect(await f.bridge.publishSkillContent(content.trimEnd() + " ")).toBeNull();
    expect(f.publications).toHaveLength(0);
  });

  it("refuses an archived crystal on direct publish and query response", async () => {
    const f = fixture();
    setupPublication(f);
    f.db.prepare("UPDATE chunks SET lifecycle = 'archived' WHERE id = 'fixture'").run();
    expect(await f.bridge.publishCrystalSkill("fixture")).toBeNull();
    await f.bridge.handleQueryEvent({ query_id: "q", query: "fixture", author_peer_id: "peer" });
    expect(f.publications).toHaveLength(0);
  });

  it.each([
    ["a non-skill chunk", { semanticType: "fact" }],
    ["an inactive lifecycle_state", { lifecycleState: "archived" }],
  ])("refuses %s even when governance and maturity allow", async (_label, chunk) => {
    const f = fixture();
    setupPublication(f, undefined, chunk);
    expect(await f.bridge.publishCrystalSkill("fixture")).toBeNull();
    expect(await f.bridge.publishSkillContent(content)).toBeNull();
    expect(f.publications).toHaveLength(0);
  });
});
