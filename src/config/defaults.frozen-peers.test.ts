import { describe, expect, it } from "vitest";
import {
  applyP2pDefaults,
  FALLBACK_BOOTSTRAP_PEERS,
  isFrozenFallbackPeerList,
} from "./defaults.js";

describe("frozen fallback bootstrap peers (drift-pass HIGH-2)", () => {
  it("a file list that is exactly the fallback peers, in any order, loads as unset", () => {
    const frozen = [...FALLBACK_BOOTSTRAP_PEERS].toReversed();
    expect(isFrozenFallbackPeerList(frozen)).toBe(true);
    expect(applyP2pDefaults({ p2p: { bootstrapPeers: frozen } }).p2p?.bootstrapPeers).toEqual(
      applyP2pDefaults({}).p2p?.bootstrapPeers,
    );
  });

  it("explicit user peers are kept (merged after the fallback list)", () => {
    const user = "/ip4/10.0.0.1/tcp/9100/p2p/12D3KooWUserPeerUserPeerUserPeerUserPeer";
    expect(isFrozenFallbackPeerList([user])).toBe(false);
    expect(isFrozenFallbackPeerList([...FALLBACK_BOOTSTRAP_PEERS, user])).toBe(false);
    const peers = applyP2pDefaults({ p2p: { bootstrapPeers: [user] } }).p2p?.bootstrapPeers;
    expect(peers).toContain(user);
    expect(peers).toHaveLength(FALLBACK_BOOTSTRAP_PEERS.length + 1);
  });
});
