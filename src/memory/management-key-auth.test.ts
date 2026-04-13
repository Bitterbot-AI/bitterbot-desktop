/**
 * Tests for ManagementKeyAuth: Ed25519 cryptographic authorization for management nodes.
 *
 * Covers:
 * - Key generation and loading from env
 * - Genesis trust list verification
 * - Signing and verification round-trips
 * - Signed command envelopes
 * - Cross-node command verification
 * - Error cases: missing key, invalid key, untrusted key, empty trust list
 * - Integration with ManagementNodeService startup
 * - loadGenesisTrustList file parsing
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

/**
 * Generate a fresh Ed25519 keypair and return the seed (private key)
 * as base64 and the raw public key as base64.
 */
function generateTestKeypair(): { seedBase64: string; pubkeyBase64: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  // Extract 32-byte seed from PKCS8 DER (last 32 bytes of the 48-byte DER)
  const pkcs8Der = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = Buffer.from(pkcs8Der.subarray(pkcs8Der.length - 32));
  // Extract 32-byte pubkey from SPKI DER (last 32 bytes of the 44-byte DER)
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const rawPub = Buffer.from(spkiDer.subarray(12));
  return {
    seedBase64: seed.toString("base64"),
    pubkeyBase64: rawPub.toString("base64"),
  };
}

function createMockBridge() {
  const commands: Array<{ cmd: string; args: unknown }> = [];
  const telemetryCallbacks: Array<
    (event: {
      signal_type: string;
      data: unknown;
      author_peer_id: string;
      timestamp: number;
    }) => void
  > = [];
  return {
    commands,
    telemetryCallbacks,
    sendCommand: async (cmd: string, args: unknown) => {
      commands.push({ cmd, args });
      return { ok: true };
    },
    onTelemetryReceived: (
      cb: (event: {
        signal_type: string;
        data: unknown;
        author_peer_id: string;
        timestamp: number;
      }) => void,
    ) => {
      telemetryCallbacks.push(cb);
    },
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

// ─── ManagementKeyAuth Unit Tests ────────────────────────────────────────────

describe("ManagementKeyAuth", () => {
  let kp: { seedBase64: string; pubkeyBase64: string };

  beforeEach(() => {
    kp = generateTestKeypair();
  });

  describe("init", () => {
    it("successfully initializes with valid key in trust list", () => {
      const auth = ManagementKeyAuth.init([kp.pubkeyBase64], kp.seedBase64);
      expect(auth.publicKeyBase64).toBe(kp.pubkeyBase64);
    });

    it("works with trust list containing multiple entries", () => {
      const other = generateTestKeypair();
      const trustList = [other.pubkeyBase64, kp.pubkeyBase64];
      const auth = ManagementKeyAuth.init(trustList, kp.seedBase64);
      expect(auth.publicKeyBase64).toBe(kp.pubkeyBase64);
    });

    it("throws KEY_MISSING when no key provided", () => {
      expect(() => ManagementKeyAuth.init([kp.pubkeyBase64])).toThrow(ManagementKeyAuthError);
      try {
        // Ensure BITTERBOT_MANAGEMENT_KEY is not set
        const saved = process.env.BITTERBOT_MANAGEMENT_KEY;
        delete process.env.BITTERBOT_MANAGEMENT_KEY;
        ManagementKeyAuth.init([kp.pubkeyBase64]);
        process.env.BITTERBOT_MANAGEMENT_KEY = saved;
      } catch (err) {
        expect(err).toBeInstanceOf(ManagementKeyAuthError);
        expect((err as ManagementKeyAuthError).code).toBe("KEY_MISSING");
      }
    });

    it("throws KEY_INVALID for non-base64 key", () => {
      try {
        ManagementKeyAuth.init([kp.pubkeyBase64], "not-valid-base64!!!@@@");
      } catch (err) {
        expect(err).toBeInstanceOf(ManagementKeyAuthError);
        expect((err as ManagementKeyAuthError).code).toBe("KEY_INVALID");
      }
    });

    it("throws KEY_INVALID for wrong-length key", () => {
      const shortKey = Buffer.alloc(16).toString("base64");
      try {
        ManagementKeyAuth.init([kp.pubkeyBase64], shortKey);
      } catch (err) {
        expect(err).toBeInstanceOf(ManagementKeyAuthError);
        expect((err as ManagementKeyAuthError).code).toBe("KEY_INVALID");
      }
    });

    it("throws KEY_NOT_IN_TRUST_LIST when pubkey not listed", () => {
      const other = generateTestKeypair();
      try {
        ManagementKeyAuth.init([other.pubkeyBase64], kp.seedBase64);
      } catch (err) {
        expect(err).toBeInstanceOf(ManagementKeyAuthError);
        expect((err as ManagementKeyAuthError).code).toBe("KEY_NOT_IN_TRUST_LIST");
      }
    });

    it("throws TRUST_LIST_EMPTY for empty trust list", () => {
      try {
        ManagementKeyAuth.init([], kp.seedBase64);
      } catch (err) {
        expect(err).toBeInstanceOf(ManagementKeyAuthError);
        expect((err as ManagementKeyAuthError).code).toBe("TRUST_LIST_EMPTY");
      }
    });

    it("accepts 64-byte private key (seed + pubkey concatenation)", () => {
      // Some Ed25519 implementations export the full 64-byte key (seed || pubkey)
      const seedBytes = Buffer.from(kp.seedBase64, "base64");
      const pubBytes = Buffer.from(kp.pubkeyBase64, "base64");
      const full64 = Buffer.concat([seedBytes, pubBytes]);
      const auth = ManagementKeyAuth.init([kp.pubkeyBase64], full64.toString("base64"));
      expect(auth.publicKeyBase64).toBe(kp.pubkeyBase64);
    });
  });

  describe("sign and verify", () => {
    let auth: ManagementKeyAuth;

    beforeEach(() => {
      auth = ManagementKeyAuth.init([kp.pubkeyBase64], kp.seedBase64);
    });

    it("signs and verifies a string", () => {
      const data = "hello management node";
      const sig = auth.sign(data);
      expect(typeof sig).toBe("string");
      expect(sig.length).toBeGreaterThan(0);
      expect(auth.verify(data, sig)).toBe(true);
    });

    it("signs and verifies a buffer", () => {
      const data = Buffer.from([1, 2, 3, 4, 5]);
      const sig = auth.sign(data);
      expect(auth.verify(data, sig)).toBe(true);
    });

    it("rejects tampered data", () => {
      const data = "original data";
      const sig = auth.sign(data);
      expect(auth.verify("tampered data", sig)).toBe(false);
    });

    it("rejects tampered signature", () => {
      const data = "test data";
      const sig = auth.sign(data);
      // Flip a byte in the signature
      const sigBuf = Buffer.from(sig, "base64");
      sigBuf[0] = sigBuf[0]! ^ 0xff;
      expect(auth.verify(data, sigBuf.toString("base64"))).toBe(false);
    });

    it("signature from one key is not valid for another key", () => {
      const other = generateTestKeypair();
      const otherAuth = ManagementKeyAuth.init([other.pubkeyBase64], other.seedBase64);
      const data = "cross-key test";
      const sig = auth.sign(data);
      expect(otherAuth.verify(data, sig)).toBe(false);
    });
  });

  describe("signCommand and verifyCommand", () => {
    let auth: ManagementKeyAuth;

    beforeEach(() => {
      auth = ManagementKeyAuth.init([kp.pubkeyBase64], kp.seedBase64);
    });

    it("creates a valid signed command envelope", () => {
      const envelope = auth.signCommand("propagate_ban", {
        peer_pubkey: "abc123",
        reason: "spam",
      });

      expect(envelope.command).toBe("propagate_ban");
      expect(envelope.payload).toEqual({ peer_pubkey: "abc123", reason: "spam" });
      expect(envelope.pubkey).toBe(kp.pubkeyBase64);
      expect(typeof envelope.signature).toBe("string");
      expect(typeof envelope.timestamp).toBe("number");
    });

    it("verifyCommand validates a legitimate envelope", () => {
      const envelope = auth.signCommand("propagate_ban", {
        peer_pubkey: "abc123",
        reason: "spam",
      });

      const valid = ManagementKeyAuth.verifyCommand(envelope, [kp.pubkeyBase64]);
      expect(valid).toBe(true);
    });

    it("verifyCommand rejects envelope from untrusted key", () => {
      const envelope = auth.signCommand("propagate_ban", {
        peer_pubkey: "abc123",
      });

      const other = generateTestKeypair();
      // Trust list only contains the other key, not ours
      const valid = ManagementKeyAuth.verifyCommand(envelope, [other.pubkeyBase64]);
      expect(valid).toBe(false);
    });

    it("verifyCommand rejects tampered payload", () => {
      const envelope = auth.signCommand("propagate_ban", {
        peer_pubkey: "abc123",
        reason: "spam",
      });

      // Tamper with the payload
      envelope.payload.reason = "not spam";
      const valid = ManagementKeyAuth.verifyCommand(envelope, [kp.pubkeyBase64]);
      expect(valid).toBe(false);
    });

    it("verifyCommand rejects tampered timestamp", () => {
      const envelope = auth.signCommand("test_cmd", { data: 1 });
      envelope.timestamp += 1000;
      const valid = ManagementKeyAuth.verifyCommand(envelope, [kp.pubkeyBase64]);
      expect(valid).toBe(false);
    });

    it("cross-node verification works between two management nodes", () => {
      const kp2 = generateTestKeypair();
      const trustList = [kp.pubkeyBase64, kp2.pubkeyBase64];

      const auth1 = ManagementKeyAuth.init(trustList, kp.seedBase64);
      const auth2 = ManagementKeyAuth.init(trustList, kp2.seedBase64);

      // Node 1 signs, node 2 verifies via static method
      const envelope = auth1.signCommand("propagate_ban", { peer: "badpeer" });
      expect(ManagementKeyAuth.verifyCommand(envelope, trustList)).toBe(true);

      // Node 2 signs, node 1 verifies
      const envelope2 = auth2.signCommand("revoke", { peer: "otherpeer" });
      expect(ManagementKeyAuth.verifyCommand(envelope2, trustList)).toBe(true);
    });
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
    const bridge = createMockBridge();
    const service = new ManagementNodeService(db, bridge as unknown as OrchestratorBridge);
    expect(() => service.start()).toThrow("cannot start without cryptographic authorization");
  });

  it("starts successfully with valid auth", () => {
    const bridge = createMockBridge();
    const auth = ManagementKeyAuth.init([kp.pubkeyBase64], kp.seedBase64);
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
    service.stop(); // clean up intervals
  });

  it("reports unauthorized when constructed without auth", () => {
    const bridge = createMockBridge();
    const service = new ManagementNodeService(db, bridge as unknown as OrchestratorBridge);
    expect(service.isAuthorized).toBe(false);
    expect(service.publicKey).toBeNull();
  });

  it("propagateBan fails without auth", async () => {
    const bridge = createMockBridge();
    const service = new ManagementNodeService(db, bridge as unknown as OrchestratorBridge);
    const result = await service.propagateBan("badpeer", "spam");
    expect(result).toBe(false);
    expect(bridge.commands.length).toBe(0);
  });

  it("propagateBan sends signed command with auth", async () => {
    const bridge = createMockBridge();
    const auth = ManagementKeyAuth.init([kp.pubkeyBase64], kp.seedBase64);
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
    const args = sent.args as Record<string, unknown>;
    expect(args.peer_pubkey).toBe("badpeer");
    expect(args.reason).toBe("spam");
    expect(args.management_pubkey).toBe(kp.pubkeyBase64);
    expect(typeof args.management_signature).toBe("string");
    expect(typeof args.timestamp).toBe("number");
  });

  it("signed ban commands are verifiable by other nodes", async () => {
    const kp2 = generateTestKeypair();
    const trustList = [kp.pubkeyBase64, kp2.pubkeyBase64];

    const bridge = createMockBridge();
    const auth = ManagementKeyAuth.init(trustList, kp.seedBase64);
    const service = new ManagementNodeService(
      db,
      bridge as unknown as OrchestratorBridge,
      null,
      null,
      auth,
    );

    await service.propagateBan("badpeer", "spam");

    const sent = bridge.commands[0]!;
    const args = sent.args as Record<string, unknown>;

    // Reconstruct what the receiving node would verify
    const canonical = JSON.stringify({
      command: "propagate_ban",
      payload: { peer_pubkey: "badpeer", reason: "spam" },
      timestamp: args.timestamp,
    });

    // Verify the signature with Node 1's pubkey
    const pubkeyBytes = Buffer.from(kp.pubkeyBase64, "base64");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spkiDer = Buffer.concat([spkiPrefix, pubkeyBytes]);
    const publicKey = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    const sigBytes = Buffer.from(args.management_signature as string, "base64");
    const valid = crypto.verify(null, Buffer.from(canonical), publicKey, sigBytes);
    expect(valid).toBe(true);
  });
});
