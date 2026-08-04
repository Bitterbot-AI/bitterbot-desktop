import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "./config.js";
import { applyP2pDefaults } from "./defaults.js";

// The hardcoded fallback bootstrap peers are the DNS-independent backstop a cold
// client dials if p2p.bitterbot.ai resolution fails. Guard that the DigitalOcean
// relay fleet (the trust-quorum nodes) is present and well-formed, so an
// accidental edit can't silently strip the backstop.

const DO_FLEET_PEER_IDS = [
  // nyc1
  "12D3KooWRWqC9ha4zvFpLTWdKWr3B8EaiQnWqr2Mp3vyRSNQNPJN",
  // fra1
  "12D3KooWMnnCHGVtZxyAFaJoEzk2hT1eD3SEvjLDiUNwiJsXdRty",
  // sgp1
  "12D3KooWNZdviN1579x6LrLQt78d6VRZczLHbBWhyyXzoun2k2L3",
];

describe("applyP2pDefaults — fallback bootstrap peers", () => {
  it("includes the full DigitalOcean relay fleet as raw /ip4 backstops", () => {
    const out = applyP2pDefaults({} as BitterbotConfig);
    const peers = out.p2p?.bootstrapPeers ?? [];
    for (const id of DO_FLEET_PEER_IDS) {
      const match = peers.find((p) => p.includes(id));
      expect(match, `expected a fallback peer for ${id}`).toBeTruthy();
      // Backstop must be DNS-independent: a raw /ip4 multiaddr on the fleet port.
      expect(match).toMatch(/^\/ip4\/\d+\.\d+\.\d+\.\d+\/tcp\/9100\/p2p\//);
    }
  });

  it("keeps DNS as the primary discovery path and enables p2p", () => {
    const out = applyP2pDefaults({} as BitterbotConfig);
    expect(out.p2p?.enabled).toBe(true);
    expect(out.p2p?.bootstrapDns).toBe("p2p.bitterbot.ai");
  });

  it("merges user-supplied peers with the fallback set, de-duplicated", () => {
    const custom = "/ip4/10.0.0.1/tcp/9100/p2p/12D3KooWCustomPeerForTest0000000000000000000000";
    // Re-supplying an existing fallback multiaddr must not duplicate it.
    const nyc1 = `/ip4/142.93.113.64/tcp/9100/p2p/${DO_FLEET_PEER_IDS[0]}`;
    const out = applyP2pDefaults({
      p2p: { bootstrapPeers: [custom, nyc1] },
    } as unknown as BitterbotConfig);
    const peers = out.p2p?.bootstrapPeers ?? [];
    expect(peers).toContain(custom);
    expect(peers.filter((p) => p === nyc1).length).toBe(1);
    expect(new Set(peers).size).toBe(peers.length);
  });
});
