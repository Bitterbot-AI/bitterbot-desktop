import { afterEach, describe, expect, it } from "vitest";
import {
  getLocalWalletCapability,
  getPeerWalletCapability,
  listPeerWalletCapabilities,
  PEER_WALLET_TTL_MS,
  recordPeerWalletCapability,
  resetWalletDiscovery,
  setLocalWalletCapability,
} from "./wallet-discovery.js";

const ADDR_A = "0x" + "ab".repeat(20);
const ADDR_B = "0x" + "cd".repeat(20);

function event(peerId: string, data: unknown, timestamp?: number) {
  return { signal_type: "wallet_capability", author_peer_id: peerId, data, timestamp };
}

describe("wallet-discovery", () => {
  afterEach(() => resetWalletDiscovery());

  it("records and resolves a valid peer wallet capability", () => {
    const accepted = recordPeerWalletCapability(
      event("12D3KooWpeerA", { address: ADDR_A, network: "base", acceptsPayments: true }),
    );
    expect(accepted).toBe(true);

    const cap = getPeerWalletCapability("12D3KooWpeerA");
    expect(cap?.address).toBe(ADDR_A);
    expect(cap?.network).toBe("base");
    expect(cap?.acceptsPayments).toBe(true);
  });

  it("ignores non-wallet_capability telemetry", () => {
    const accepted = recordPeerWalletCapability({
      signal_type: "novelty",
      author_peer_id: "12D3KooWpeerA",
      data: { address: ADDR_A },
    });
    expect(accepted).toBe(false);
    expect(getPeerWalletCapability("12D3KooWpeerA")).toBeNull();
  });

  it("rejects malformed or missing addresses", () => {
    expect(recordPeerWalletCapability(event("p1", { address: "not-an-address" }))).toBe(false);
    expect(recordPeerWalletCapability(event("p2", { address: "0x123" }))).toBe(false);
    expect(recordPeerWalletCapability(event("p3", {}))).toBe(false);
    expect(listPeerWalletCapabilities()).toHaveLength(0);
  });

  it("defaults acceptsPayments to true unless explicitly false", () => {
    recordPeerWalletCapability(event("p-default", { address: ADDR_A }));
    recordPeerWalletCapability(event("p-optout", { address: ADDR_B, acceptsPayments: false }));
    expect(getPeerWalletCapability("p-default")?.acceptsPayments).toBe(true);
    expect(getPeerWalletCapability("p-optout")?.acceptsPayments).toBe(false);
  });

  it("treats stale entries (older than the TTL) as absent", () => {
    const now = 1_000_000_000_000;
    recordPeerWalletCapability(event("stale", { address: ADDR_A }, now - PEER_WALLET_TTL_MS - 1));
    recordPeerWalletCapability(event("fresh", { address: ADDR_B }, now - 1_000));

    expect(getPeerWalletCapability("stale", now)).toBeNull();
    expect(getPeerWalletCapability("fresh", now)?.address).toBe(ADDR_B);
    expect(listPeerWalletCapabilities(now).map((c) => c.peerId)).toEqual(["fresh"]);
  });

  it("upserts the latest capability for a peer", () => {
    const now = Date.now();
    recordPeerWalletCapability(event("p", { address: ADDR_A }, now - 2_000));
    recordPeerWalletCapability(event("p", { address: ADDR_B }, now - 1_000));
    expect(getPeerWalletCapability("p")?.address).toBe(ADDR_B);
    expect(listPeerWalletCapabilities()).toHaveLength(1);
  });

  it("stores and clears the local capability", () => {
    expect(getLocalWalletCapability()).toBeNull();
    setLocalWalletCapability({
      address: ADDR_A,
      network: "base",
      acceptsPayments: true,
      updatedAt: Date.now(),
    });
    expect(getLocalWalletCapability()?.address).toBe(ADDR_A);
    resetWalletDiscovery();
    expect(getLocalWalletCapability()).toBeNull();
  });
});
