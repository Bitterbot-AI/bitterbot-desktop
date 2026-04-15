/**
 * Tests for ManagementKeyAuth — the thin authorization wrapper over the
 * orchestrator's libp2p Ed25519 keypair.
 *
 * The old env-var-private-key model has been replaced: identity is now
 * discovered over IPC from the orchestrator, which owns the private key
 * material. These tests mock the bridge and verify auth/trust-list behavior
 * around that identity.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OrchestratorBridge } from "../infra/orchestrator-bridge.js";
import {
  ManagementKeyAuth,
  ManagementKeyAuthError,
  loadGenesisTrustList,
} from "./management-key-auth.js";
import { ManagementNodeService } from "./management-node-service.js";
import { ensureMemoryIndexSchema, ensureColumn } from "./memory-schema.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateTestKeypair(): { seedBase64: string; pubkeyBase64: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8Der = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = Buffer.from(pkcs8Der.subarray(pkcs8Der.length - 32));
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const rawPub = Buffer.from(spkiDer.subarray(12));
  return {
    seedBase64: seed.toString("base64"),
    pubkeyBase64: rawPub.toString("base64"),
  };
}

type MockBridge = {
  commands: Array<{ cmd: string; args: unknown }>;
  isConnected: () => boolean;
  getIdentity: () => Promise<{ pubkey: string; peerId: string; nodeTier: string }>;
  sendCommand: (cmd: string, args: unknown) => Promise<Record<string, unknown> | undefined>;
  onTelemetryReceived: (
    cb: (event: {
      signal_type: string;
      data: unknown;
      author_peer_id: string;
      timestamp: number;
    }) => void,
  ) => void;
};

function createMockBridge(opts: {
  pubkey?: string;
  peerId?: string;
  nodeTier?: string;
  connected?: boolean;
  identityError?: Error;
  sendResponse?: Record<string, unknown> | undefined;
}): MockBridge {
  const commands: Array<{ cmd: string; args: unknown }> = [];
  const connected = opts.connected ?? true;
  const identityError = opts.identityError;
  return {
    commands,
    isConnected: () => connected,
    getIdentity: async () => {
      if (identityError) {
        throw identityError;
      }
      return {
        pubkey: opts.pubkey ?? "dummy-pubkey",
        peerId: opts.peerId ?? "12D3KooWDummy",
        nodeTier: opts.nodeTier ?? "management",
      };
    },
    sendCommand: async (cmd, args) => {
      commands.push({ cmd, args });
      return opts.sendResponse ?? { ok: true };
    },
    onTelemetryReceived: () => {},
  };
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

// ─── ManagementKeyAuth.init ──────────────────────────────────────────────────

describe("ManagementKeyAuth.init", () => {
  let kp: { seedBase64: string; pubkeyBase64: string };

  beforeEach(() => {
    kp = generateTestKeypair();
  });

  it("succeeds when orchestrator pubkey is in the trust list", async () => {
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64 });
    const auth = await ManagementKeyAuth.init(
      [kp.pubkeyBase64],
      bridge as unknown as OrchestratorBridge,
    );
    expect(auth.publicKeyBase64).toBe(kp.pubkeyBase64);
    expect(auth.peerId).toBe("12D3KooWDummy");
  });

  it("works with trust list containing multiple entries", async () => {
    const other = generateTestKeypair();
    const trustList = [other.pubkeyBase64, kp.pubkeyBase64];
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64 });
    const auth = await ManagementKeyAuth.init(trustList, bridge as unknown as OrchestratorBridge);
    expect(auth.publicKeyBase64).toBe(kp.pubkeyBase64);
  });

  it("throws TRUST_LIST_EMPTY for empty trust list", async () => {
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64 });
    await expect(
      ManagementKeyAuth.init([], bridge as unknown as OrchestratorBridge),
    ).rejects.toMatchObject({
      name: "ManagementKeyAuthError",
      code: "TRUST_LIST_EMPTY",
    });
  });

  it("throws BRIDGE_NOT_READY when bridge is disconnected", async () => {
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64, connected: false });
    await expect(
      ManagementKeyAuth.init([kp.pubkeyBase64], bridge as unknown as OrchestratorBridge),
    ).rejects.toMatchObject({
      name: "ManagementKeyAuthError",
      code: "BRIDGE_NOT_READY",
    });
  });

  it("throws IDENTITY_FETCH_FAILED when getIdentity throws", async () => {
    const bridge = createMockBridge({
      identityError: new Error("IPC timeout"),
    });
    await expect(
      ManagementKeyAuth.init([kp.pubkeyBase64], bridge as unknown as OrchestratorBridge),
    ).rejects.toMatchObject({
      name: "ManagementKeyAuthError",
      code: "IDENTITY_FETCH_FAILED",
    });
  });

  it("throws KEY_NOT_IN_TRUST_LIST when orchestrator pubkey is not listed", async () => {
    const other = generateTestKeypair();
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64 });
    await expect(
      ManagementKeyAuth.init([other.pubkeyBase64], bridge as unknown as OrchestratorBridge),
    ).rejects.toMatchObject({
      name: "ManagementKeyAuthError",
      code: "KEY_NOT_IN_TRUST_LIST",
    });
  });

  it("auth error is an instance of ManagementKeyAuthError", async () => {
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64, connected: false });
    try {
      await ManagementKeyAuth.init([kp.pubkeyBase64], bridge as unknown as OrchestratorBridge);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ManagementKeyAuthError);
    }
  });
});

// ─── ManagementKeyAuth.verifyCommand (cross-peer verification) ───────────────

describe("ManagementKeyAuth.verifyCommand", () => {
  // Helper to produce an Ed25519-signed envelope using Node crypto directly.
  // In production this signature would come from the orchestrator, but the
  // verification side is pure Node crypto — testable in isolation.
  function signEnvelope(
    command: string,
    payload: Record<string, unknown>,
    timestamp: number,
    seedBase64: string,
    pubkeyBase64: string,
  ): {
    command: string;
    payload: Record<string, unknown>;
    timestamp: number;
    pubkey: string;
    signature: string;
  } {
    const seed = Buffer.from(seedBase64, "base64");
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const pkcs8Der = Buffer.concat([pkcs8Prefix, seed]);
    const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
    const canonical = JSON.stringify({ command, payload, timestamp });
    const sig = crypto.sign(null, Buffer.from(canonical), privateKey);
    return {
      command,
      payload,
      timestamp,
      pubkey: pubkeyBase64,
      signature: sig.toString("base64"),
    };
  }

  it("accepts a legitimate envelope whose pubkey is in the trust list", () => {
    const kp = generateTestKeypair();
    const envelope = signEnvelope(
      "propagate_ban",
      { peer_pubkey: "abc123", reason: "spam" },
      Date.now(),
      kp.seedBase64,
      kp.pubkeyBase64,
    );
    expect(ManagementKeyAuth.verifyCommand(envelope, [kp.pubkeyBase64])).toBe(true);
  });

  it("rejects envelope from untrusted pubkey", () => {
    const kp = generateTestKeypair();
    const other = generateTestKeypair();
    const envelope = signEnvelope(
      "propagate_ban",
      { peer_pubkey: "abc123" },
      Date.now(),
      kp.seedBase64,
      kp.pubkeyBase64,
    );
    expect(ManagementKeyAuth.verifyCommand(envelope, [other.pubkeyBase64])).toBe(false);
  });

  it("rejects tampered payload", () => {
    const kp = generateTestKeypair();
    const envelope = signEnvelope(
      "propagate_ban",
      { peer_pubkey: "abc123", reason: "spam" },
      Date.now(),
      kp.seedBase64,
      kp.pubkeyBase64,
    );
    envelope.payload.reason = "not spam";
    expect(ManagementKeyAuth.verifyCommand(envelope, [kp.pubkeyBase64])).toBe(false);
  });

  it("rejects tampered timestamp", () => {
    const kp = generateTestKeypair();
    const envelope = signEnvelope(
      "test_cmd",
      { data: 1 },
      Date.now(),
      kp.seedBase64,
      kp.pubkeyBase64,
    );
    envelope.timestamp += 1000;
    expect(ManagementKeyAuth.verifyCommand(envelope, [kp.pubkeyBase64])).toBe(false);
  });

  it("works across nodes with a shared trust list", () => {
    const kp1 = generateTestKeypair();
    const kp2 = generateTestKeypair();
    const trustList = [kp1.pubkeyBase64, kp2.pubkeyBase64];

    const env1 = signEnvelope("ban", { peer: "a" }, Date.now(), kp1.seedBase64, kp1.pubkeyBase64);
    const env2 = signEnvelope(
      "revoke",
      { peer: "b" },
      Date.now(),
      kp2.seedBase64,
      kp2.pubkeyBase64,
    );

    expect(ManagementKeyAuth.verifyCommand(env1, trustList)).toBe(true);
    expect(ManagementKeyAuth.verifyCommand(env2, trustList)).toBe(true);
  });
});

// ─── loadGenesisTrustList ────────────────────────────────────────────────────

describe("loadGenesisTrustList", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mgmt-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads from inline array", () => {
    const list = loadGenesisTrustList(undefined, ["key1", "key2"]);
    expect(list).toEqual(["key1", "key2"]);
  });

  it("loads from file", () => {
    const filePath = path.join(tmpDir, "trust.txt");
    fs.writeFileSync(filePath, "keyA\nkeyB\nkeyC\n");
    const list = loadGenesisTrustList(filePath);
    expect(list).toEqual(["keyA", "keyB", "keyC"]);
  });

  it("ignores blank lines and comments in file", () => {
    const filePath = path.join(tmpDir, "trust.txt");
    fs.writeFileSync(filePath, "# Genesis trust list\nkeyA\n\n# Another comment\nkeyB\n\n");
    const list = loadGenesisTrustList(filePath);
    expect(list).toEqual(["keyA", "keyB"]);
  });

  it("merges inline and file entries", () => {
    const filePath = path.join(tmpDir, "trust.txt");
    fs.writeFileSync(filePath, "keyC\n");
    const list = loadGenesisTrustList(filePath, ["keyA", "keyB"]);
    expect(list).toEqual(["keyA", "keyB", "keyC"]);
  });

  it("deduplicates entries", () => {
    const filePath = path.join(tmpDir, "trust.txt");
    fs.writeFileSync(filePath, "keyA\nkeyB\n");
    const list = loadGenesisTrustList(filePath, ["keyA"]);
    expect(list).toEqual(["keyA", "keyB"]);
  });

  it("handles missing file gracefully", () => {
    const list = loadGenesisTrustList("/nonexistent/path/trust.txt");
    expect(list).toEqual([]);
  });

  it("returns empty array when no sources provided", () => {
    const list = loadGenesisTrustList();
    expect(list).toEqual([]);
  });
});

// ─── ManagementNodeService Integration ───────────────────────────────────────

describe("ManagementNodeService with auth", () => {
  let kp: { seedBase64: string; pubkeyBase64: string };
  let db: DatabaseSync;

  beforeEach(() => {
    kp = generateTestKeypair();
    db = createTestDb();
  });

  it("refuses to start without auth", () => {
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64 });
    const service = new ManagementNodeService(db, bridge as unknown as OrchestratorBridge);
    expect(() => service.start()).toThrow("cannot start without management-node authorization");
  });

  it("starts successfully with valid auth", async () => {
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64 });
    const auth = await ManagementKeyAuth.init(
      [kp.pubkeyBase64],
      bridge as unknown as OrchestratorBridge,
    );
    const service = new ManagementNodeService(
      db,
      bridge as unknown as OrchestratorBridge,
      null,
      null,
      auth,
    );
    expect(service.isAuthorized).toBe(true);
    expect(service.publicKey).toBe(kp.pubkeyBase64);
    service.start();
    service.stop();
  });

  it("reports unauthorized when constructed without auth", () => {
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64 });
    const service = new ManagementNodeService(db, bridge as unknown as OrchestratorBridge);
    expect(service.isAuthorized).toBe(false);
    expect(service.publicKey).toBeNull();
  });

  it("propagateBan fails without auth", async () => {
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64 });
    const service = new ManagementNodeService(db, bridge as unknown as OrchestratorBridge);
    const result = await service.propagateBan("badpeer", "spam");
    expect(result).toBe(false);
    expect(bridge.commands.length).toBe(0);
  });

  it("propagateBan forwards to orchestrator (which signs with libp2p key)", async () => {
    const bridge = createMockBridge({ pubkey: kp.pubkeyBase64 });
    const auth = await ManagementKeyAuth.init(
      [kp.pubkeyBase64],
      bridge as unknown as OrchestratorBridge,
    );
    const service = new ManagementNodeService(
      db,
      bridge as unknown as OrchestratorBridge,
      null,
      null,
      auth,
    );

    const result = await service.propagateBan("badpeer", "spam");
    expect(result).toBe(true);
    expect(bridge.commands.length).toBe(1);

    const sent = bridge.commands[0]!;
    expect(sent.cmd).toBe("propagate_ban");
    // The TS layer only forwards peer_pubkey + reason. The orchestrator
    // produces the signature internally using its libp2p Ed25519 key, so
    // TS no longer adds management_pubkey/management_signature/timestamp.
    const args = sent.args as Record<string, unknown>;
    expect(args.peer_pubkey).toBe("badpeer");
    expect(args.reason).toBe("spam");
    expect(args.management_pubkey).toBeUndefined();
    expect(args.management_signature).toBeUndefined();
  });

  it("propagateBan returns false when orchestrator rejects", async () => {
    const bridge = createMockBridge({
      pubkey: kp.pubkeyBase64,
      sendResponse: { ok: false, error: "not a management node" },
    });
    const auth = await ManagementKeyAuth.init(
      [kp.pubkeyBase64],
      bridge as unknown as OrchestratorBridge,
    );
    const service = new ManagementNodeService(
      db,
      bridge as unknown as OrchestratorBridge,
      null,
      null,
      auth,
    );

    const result = await service.propagateBan("badpeer", "spam");
    expect(result).toBe(false);
  });
});
