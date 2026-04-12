/**
 * Integration test: full management node startup flow.
 *
 * Simulates what the gateway does when starting a management-tier node:
 *   config → trust list → ManagementKeyAuth → ManagementNodeService → signed operations
 *
 * Uses real Ed25519 keys, real trust list file, and real SQLite.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ManagementKeyAuth,
  ManagementKeyAuthError,
  loadGenesisTrustList,
} from "./management-key-auth.js";
import { ManagementNodeService } from "./management-node-service.js";
import { ensureMemoryIndexSchema, ensureColumn } from "./memory-schema.js";
import { PeerReputationManager } from "./peer-reputation.js";
import { SkillExecutionTracker } from "./skill-execution-tracker.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8Der = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = Buffer.from(pkcs8Der.subarray(pkcs8Der.length - 32));
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const rawPub = Buffer.from(spkiDer.subarray(12));
  return { seedBase64: seed.toString("base64"), pubkeyBase64: rawPub.toString("base64") };
}

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureColumn(db, "chunks", "publish_visibility", "TEXT");
  ensureColumn(db, "chunks", "published_at", "INTEGER");
  return db;
}

function createMockBridge() {
  const commands: Array<{ cmd: string; args: unknown }> = [];
  const telemetryCbs: Array<(event: any) => void> = [];
  return {
    commands,
    telemetryCbs,
    sendCommand: async (cmd: string, args: unknown) => {
      commands.push({ cmd, args });
      return { ok: true };
    },
    onTelemetryReceived: (cb: (event: any) => void) => {
      telemetryCbs.push(cb);
    },
  };
}

// ─── Integration Tests ───────────────────────────────────────────────────────

describe("Management Node Integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mgmt-integ-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full startup flow: config → trust list file → auth → service → signed ban", async () => {
    // 1. Generate management keypair (simulates running scripts/management-keygen.ts)
    const mgmtKey = generateKeypair();

    // 2. Write trust list file (simulates ~/.bitterbot/genesis-trust.txt)
    const trustListPath = path.join(tmpDir, "genesis-trust.txt");
    fs.writeFileSync(
      trustListPath,
      ["# Genesis trust list for test network", mgmtKey.pubkeyBase64, ""].join("\n"),
    );

    // 3. Load trust list from file (simulates loadGenesisTrustList in manager.ts)
    const trustList = loadGenesisTrustList(trustListPath);
    expect(trustList).toEqual([mgmtKey.pubkeyBase64]);

    // 4. Initialize auth from env var (simulates ManagementKeyAuth.init in ensureManagementNodeService)
    const auth = ManagementKeyAuth.init(trustList, mgmtKey.seedBase64);
    expect(auth.publicKeyBase64).toBe(mgmtKey.pubkeyBase64);

    // 5. Create management node service with auth
    const db = createTestDb();
    const bridge = createMockBridge();
    const tracker = new SkillExecutionTracker(db);
    const peerRep = new PeerReputationManager(db, tracker, trustList);
    const service = new ManagementNodeService(db, bridge as any, peerRep, null, auth);

    expect(service.isAuthorized).toBe(true);
    expect(service.publicKey).toBe(mgmtKey.pubkeyBase64);

    // 6. Start the service (should not throw)
    service.start();

    // 7. Propagate a ban — should sign the command
    const banResult = await service.propagateBan("malicious-peer-pubkey", "spam flood");
    expect(banResult).toBe(true);

    // 8. Verify the signed command was sent to the bridge
    expect(bridge.commands.length).toBe(1);
    const banCmd = bridge.commands[0]!;
    expect(banCmd.cmd).toBe("propagate_ban");
    const args = banCmd.args as Record<string, unknown>;
    expect(args.peer_pubkey).toBe("malicious-peer-pubkey");
    expect(args.reason).toBe("spam flood");
    expect(args.management_pubkey).toBe(mgmtKey.pubkeyBase64);
    expect(typeof args.management_signature).toBe("string");

    // 9. Verify the signature is valid (simulates what a receiving node does)
    const envelope = auth.signCommand("propagate_ban", {
      peer_pubkey: "malicious-peer-pubkey",
      reason: "spam flood",
    });
    expect(ManagementKeyAuth.verifyCommand(envelope, trustList)).toBe(true);

    // 10. Verify peer was actually banned in local reputation
    expect(peerRep.isBanned("malicious-peer-pubkey")).toBe(true);

    // 11. Verify management node is recognized in reputation system
    expect(peerRep.isManagementNode(mgmtKey.pubkeyBase64)).toBe(true);

    service.stop();
  });

  it("rejects startup when BITTERBOT_MANAGEMENT_KEY not set", () => {
    const mgmtKey = generateKeypair();
    const trustList = [mgmtKey.pubkeyBase64];

    // Without key override and without env var set
    const saved = process.env.BITTERBOT_MANAGEMENT_KEY;
    delete process.env.BITTERBOT_MANAGEMENT_KEY;
    try {
      expect(() => ManagementKeyAuth.init(trustList)).toThrow(ManagementKeyAuthError);
    } finally {
      if (saved) {
        process.env.BITTERBOT_MANAGEMENT_KEY = saved;
      }
    }

    // Service without auth refuses to start
    const db = createTestDb();
    const bridge = createMockBridge();
    const service = new ManagementNodeService(db, bridge as any);
    expect(() => service.start()).toThrow("cannot start without cryptographic authorization");
  });

  it("rejects key not in trust list", () => {
    const mgmtKey = generateKeypair();
    const rogueKey = generateKeypair();

    // Trust list only has the legit key
    const trustList = [mgmtKey.pubkeyBase64];

    // Rogue tries to init with their key
    expect(() => ManagementKeyAuth.init(trustList, rogueKey.seedBase64)).toThrow(
      ManagementKeyAuthError,
    );
    try {
      ManagementKeyAuth.init(trustList, rogueKey.seedBase64);
    } catch (err) {
      expect((err as ManagementKeyAuthError).code).toBe("KEY_NOT_IN_TRUST_LIST");
    }
  });

  it("multi-node trust: two management nodes can verify each other's bans", async () => {
    const node1 = generateKeypair();
    const node2 = generateKeypair();
    const trustList = [node1.pubkeyBase64, node2.pubkeyBase64];

    // Both nodes initialize auth
    const auth1 = ManagementKeyAuth.init(trustList, node1.seedBase64);
    const auth2 = ManagementKeyAuth.init(trustList, node2.seedBase64);

    // Node 1 creates services
    const db1 = createTestDb();
    const bridge1 = createMockBridge();
    const tracker1 = new SkillExecutionTracker(db1);
    const rep1 = new PeerReputationManager(db1, tracker1, trustList);
    const svc1 = new ManagementNodeService(db1, bridge1 as any, rep1, null, auth1);
    svc1.start();

    // Node 2 creates services
    const db2 = createTestDb();
    const bridge2 = createMockBridge();
    const tracker2 = new SkillExecutionTracker(db2);
    const rep2 = new PeerReputationManager(db2, tracker2, trustList);
    const svc2 = new ManagementNodeService(db2, bridge2 as any, rep2, null, auth2);
    svc2.start();

    // Node 1 bans a peer
    await svc1.propagateBan("evil-peer", "malicious behavior");
    const banArgs = bridge1.commands[0]!.args as Record<string, unknown>;

    // Node 2 receives the ban and verifies the signature
    const signedEnvelope = {
      command: "propagate_ban",
      payload: { peer_pubkey: "evil-peer", reason: "malicious behavior" },
      timestamp: banArgs.timestamp as number,
      pubkey: banArgs.management_pubkey as string,
      signature: banArgs.management_signature as string,
    };

    // Node 2 verifies: sender's pubkey in trust list + valid signature
    expect(ManagementKeyAuth.verifyCommand(signedEnvelope, trustList)).toBe(true);
    expect(rep2.isManagementNode(signedEnvelope.pubkey)).toBe(true);

    // Node 2 would not verify a forged signature
    const forged = { ...signedEnvelope, signature: "AAAA" + signedEnvelope.signature.slice(4) };
    expect(ManagementKeyAuth.verifyCommand(forged, trustList)).toBe(false);

    svc1.stop();
    svc2.stop();
  });

  it("handleBanReceived verifies management source via reputation", () => {
    const mgmtKey = generateKeypair();
    const edgeKey = generateKeypair();
    const trustList = [mgmtKey.pubkeyBase64];

    const db = createTestDb();
    const bridge = createMockBridge();
    const tracker = new SkillExecutionTracker(db);
    const rep = new PeerReputationManager(db, tracker, trustList);
    const auth = ManagementKeyAuth.init(trustList, mgmtKey.seedBase64);
    const service = new ManagementNodeService(db, bridge as any, rep, null, auth);
    service.start();

    // Simulate receiving a ban from another management node (via telemetry callback)
    const telemetryCb = bridge.telemetryCbs[0]!;

    // Valid ban from management node
    telemetryCb({
      signal_type: "management_ban",
      data: { peer_pubkey: "target-peer", reason: "bad actor" },
      author_peer_id: "mgmt-peer-123",
      author_pubkey: mgmtKey.pubkeyBase64,
      timestamp: Date.now(),
    });
    expect(rep.isBanned("target-peer")).toBe(true);

    // Invalid ban from edge node (not in trust list) — should be rejected
    telemetryCb({
      signal_type: "management_ban",
      data: { peer_pubkey: "innocent-peer", reason: "attempted ban" },
      author_peer_id: "edge-peer-456",
      author_pubkey: edgeKey.pubkeyBase64,
      timestamp: Date.now(),
    });
    expect(rep.isBanned("innocent-peer")).toBe(false);

    service.stop();
  });
});
