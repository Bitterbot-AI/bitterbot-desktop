import { DatabaseSync } from "node:sqlite";
import { twistedEdwards } from "@noble/curves/abstract/edwards";
import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NANO_NETWORK,
  isValidNanoAccount,
  nanoAccountToPublicKey,
  nanoPaymentMessage,
  publicKeyToNanoAccount,
  usdToRaw,
  verifyNanoPayment,
} from "./nano-verify.js";

// Test-only signer: Ed25519 with BLAKE2b-512, the scheme Nano account keys use.
const signer = twistedEdwards({ ...ed25519.CURVE, hash: blake2b });

function keyPair(seedByte: number) {
  const priv = new Uint8Array(32).fill(seedByte);
  const pub = signer.getPublicKey(priv);
  return { priv, account: publicKeyToNanoAccount(pub) };
}

const payer = keyPair(1);
const stranger = keyPair(2);
const payee = keyPair(3);
const other = keyPair(4);

// 1 USD = 1e29 raw (0.1 XNO); a $0.05 price is 5e27 raw.
const RAW_PER_USD = "100000000000000000000000000000";
const PRICE_USD = 0.05;
const PRICE_RAW = usdToRaw(PRICE_USD, RAW_PER_USD).toString();
const HASH = "ab".repeat(32);
const RPC = "http://nano-node.test:7076";

function makeToken(
  over: {
    blockHash?: string;
    account?: string;
    recipient?: string;
    amountRaw?: string;
    timestamp?: number;
    signWith?: Uint8Array;
    signature?: string;
  } = {},
) {
  const t = {
    network: NANO_NETWORK,
    blockHash: over.blockHash ?? HASH,
    account: over.account ?? payer.account,
    recipient: over.recipient ?? payee.account,
    amountRaw: over.amountRaw ?? PRICE_RAW,
    timestamp: over.timestamp ?? Date.now(),
  };
  const msg = new TextEncoder().encode(nanoPaymentMessage(t));
  const signature =
    over.signature ??
    Buffer.from(signer.sign(msg, over.signWith ?? payer.priv))
      .toString("hex")
      .toUpperCase();
  return Buffer.from(JSON.stringify({ ...t, signature })).toString("base64");
}

function blockInfo(over: Record<string, unknown> = {}, contents: Record<string, unknown> = {}) {
  return {
    block_account: payer.account,
    amount: PRICE_RAW,
    local_timestamp: String(Math.floor(Date.now() / 1000) - 5),
    confirmed: "true",
    subtype: "send",
    ...over,
    contents: { type: "state", link_as_account: payee.account, ...contents },
  };
}

function mockRpc(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ledgerDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE x402_consumed_tx (tx_hash TEXT PRIMARY KEY, consumed_at INTEGER NOT NULL)`);
  return db;
}

function verify(token: string, db?: DatabaseSync) {
  return verifyNanoPayment({
    paymentToken: token,
    expectedRecipient: payee.account,
    minimumUsd: PRICE_USD,
    rawPerUsd: RAW_PER_USD,
    rpcUrl: RPC,
    db,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("nano account checksum", () => {
  it("accepts a well-formed account and rejects a bad checksum", () => {
    expect(isValidNanoAccount(payer.account)).toBe(true);
    const last = payer.account.at(-1)!;
    const flipped = payer.account.slice(0, -1) + (last === "1" ? "3" : "1");
    expect(isValidNanoAccount(flipped)).toBe(false);
    expect(isValidNanoAccount("nano_" + "1".repeat(59))).toBe(false);
    expect(isValidNanoAccount("0x" + "11".repeat(20))).toBe(false);
  });

  it("matches the live network: genesis account and genesis block signature", () => {
    const pub = nanoAccountToPublicKey(
      "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3",
    )!;
    expect(Buffer.from(pub).toString("hex").toUpperCase()).toBe(
      "E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA",
    );
    // Nano block signatures use the same Ed25519-BLAKE2b scheme as payment proofs.
    const genesisHash = Buffer.from(
      "991CF190094C00F0B68E2E5F75F6BEE95A2E0BD93CEAA4A6734DB9F19B728948",
      "hex",
    );
    const genesisSig =
      "9F0C933C8ADE004D808EA1985FA746A7E95BA2A38F867640F53EC8F180BDFE9E" +
      "2C1268DEAD7C2664F356E37ABA362BC58E46DBA03E523A7B5A19E4B6EB12BB02";
    expect(signer.verify(genesisSig, genesisHash, pub)).toBe(true);
  });
});

describe("usdToRaw", () => {
  it("converts with BigInt and rounds up", () => {
    expect(usdToRaw(0.05, RAW_PER_USD)).toBe(5_000_000_000_000_000_000_000_000_000n);
    expect(usdToRaw(0.000001, "3")).toBe(1n);
  });
});

describe("verifyNanoPayment", () => {
  it("accepts a confirmed, signed send to us that covers the price", async () => {
    const fetchMock = mockRpc(blockInfo());
    const r = await verify(makeToken(), ledgerDb());
    expect(r).toMatchObject({ valid: true, blockHash: HASH.toUpperCase(), amountRaw: PRICE_RAW });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RPC);
    expect(JSON.parse(init.body as string)).toEqual({
      action: "block_info",
      json_block: "true",
      hash: HASH.toUpperCase(),
    });
  });

  it("refuses an underpaid block", async () => {
    const short = (BigInt(PRICE_RAW) - 1n).toString();
    mockRpc(blockInfo({ amount: short }));
    expect((await verify(makeToken({ amountRaw: short }))).valid).toBe(false);
    mockRpc(blockInfo({ amount: short }));
    const r = await verify(makeToken());
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/does not cover/);
  });

  it("refuses an unconfirmed block", async () => {
    mockRpc(blockInfo({ confirmed: "false" }));
    expect((await verify(makeToken())).error).toMatch(/not confirmed/);
  });

  it("refuses a receive block", async () => {
    mockRpc(blockInfo({ subtype: "receive" }));
    expect((await verify(makeToken())).error).toMatch(/not a send/);
  });

  it("refuses a send to another account", async () => {
    mockRpc(blockInfo({}, { link_as_account: other.account }));
    expect((await verify(makeToken())).error).toMatch(/expected recipient/);
  });

  it("refuses a token addressed to another recipient", async () => {
    mockRpc(blockInfo());
    expect((await verify(makeToken({ recipient: other.account }))).error).toMatch(
      /recipient does not match/,
    );
  });

  it("refuses a block sent by someone other than the signer", async () => {
    mockRpc(blockInfo({ block_account: other.account }));
    expect((await verify(makeToken())).error).toMatch(/declared account/);
  });

  it("refuses a stale token and a stale block", async () => {
    const fetchMock = mockRpc(blockInfo());
    expect((await verify(makeToken({ timestamp: Date.now() - 6 * 60 * 1000 }))).error).toMatch(
      /expired/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    mockRpc(blockInfo({ local_timestamp: String(Math.floor(Date.now() / 1000) - 3600) }));
    expect((await verify(makeToken())).error).toMatch(/too old/);
  });

  it("refuses a signature by a different key or over different bytes", async () => {
    const fetchMock = mockRpc(blockInfo());
    expect((await verify(makeToken({ signWith: stranger.priv }))).error).toMatch(/signature/);
    expect((await verify(makeToken({ signature: "00".repeat(64) }))).valid).toBe(false);
    expect((await verify(makeToken({ signature: "zz" }))).error).toMatch(/not signed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed block hash and a bad account checksum", async () => {
    const fetchMock = mockRpc(blockInfo());
    expect((await verify(makeToken({ blockHash: "abc" }))).error).toMatch(/block hash/);
    const bad = payer.account.slice(0, -1) + (payer.account.at(-1) === "1" ? "3" : "1");
    expect((await verify(makeToken({ account: bad }))).error).toMatch(/sender account/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a replay of the same block", async () => {
    const db = ledgerDb();
    mockRpc(blockInfo());
    expect((await verify(makeToken(), db)).valid).toBe(true);
    mockRpc(blockInfo());
    const r = await verify(makeToken(), db);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/already consumed/);
    const row = db.prepare(`SELECT tx_hash FROM x402_consumed_tx`).get() as { tx_hash: string };
    expect(row.tx_hash).toBe(`nano:${HASH.toUpperCase()}`);
  });

  it("only one of N concurrent claims of the same block wins", async () => {
    const db = ledgerDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(blockInfo()), { status: 200 })),
    );
    const token = makeToken();
    const results = await Promise.all(Array.from({ length: 5 }, () => verify(token, db)));
    expect(results.filter((r) => r.valid)).toHaveLength(1);
  });

  it("is never paid when the node is down or answers non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect((await verify(makeToken())).error).toMatch(/RPC failed/);
    mockRpc({ error: "busy" }, 503);
    expect((await verify(makeToken())).error).toMatch(/HTTP 503/);
    mockRpc({ error: "Block not found" });
    expect((await verify(makeToken())).error).toMatch(/Block not found/);
  });

  it("ignores tokens for other networks", async () => {
    const t = Buffer.from(JSON.stringify({ txHash: "0xabc", amount: 1 })).toString("base64");
    expect((await verify(t)).valid).toBe(false);
  });
});
