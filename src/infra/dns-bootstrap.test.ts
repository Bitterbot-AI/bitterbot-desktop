/**
 * Tests for DNS bootstrap peer discovery.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveBootstrapDns, mergeBootstrapPeers } from "./dns-bootstrap.js";

// Mock node:dns
vi.mock("node:dns", () => ({
  promises: {
    resolveTxt: vi.fn(),
  },
}));

import { promises as dns } from "node:dns";
const mockResolveTxt = vi.mocked(dns.resolveTxt);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveBootstrapDns", () => {
  it("resolves dnsaddr TXT records into multiaddresses", async () => {
    mockResolveTxt.mockResolvedValue([
      ["dnsaddr=/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest1"],
      ["dnsaddr=/ip4/5.6.7.8/tcp/9000/p2p/12D3KooWTest2"],
    ]);

    const peers = await resolveBootstrapDns("p2p.example.com");

    expect(mockResolveTxt).toHaveBeenCalledWith("_dnsaddr.p2p.example.com");
    expect(peers).toEqual([
      "/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest1",
      "/ip4/5.6.7.8/tcp/9000/p2p/12D3KooWTest2",
    ]);
  });

  it("ignores TXT records without dnsaddr= prefix", async () => {
    mockResolveTxt.mockResolvedValue([
      ["dnsaddr=/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest1"],
      ["v=spf1 include:example.com ~all"],
      ["some other record"],
    ]);

    const peers = await resolveBootstrapDns("p2p.example.com");
    expect(peers).toEqual(["/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest1"]);
  });

  it("handles multi-string TXT records (joined)", async () => {
    // DNS TXT records can be split into multiple strings
    mockResolveTxt.mockResolvedValue([["dnsaddr=/ip4/1.2.3.4/tcp/4001", "/p2p/12D3KooWTest1"]]);

    const peers = await resolveBootstrapDns("example.com");
    expect(peers).toEqual(["/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest1"]);
  });

  it("returns empty array for ENODATA (no TXT records)", async () => {
    const err = Object.assign(new Error("queryTxt ENODATA _dnsaddr.nope.example.com"), {
      code: "ENODATA",
    });
    mockResolveTxt.mockRejectedValue(err);

    const peers = await resolveBootstrapDns("nope.example.com");
    expect(peers).toEqual([]);
  });

  it("returns empty array for ENOTFOUND (domain doesn't exist)", async () => {
    const err = Object.assign(new Error("queryTxt ENOTFOUND _dnsaddr.nope.example.com"), {
      code: "ENOTFOUND",
    });
    mockResolveTxt.mockRejectedValue(err);

    const peers = await resolveBootstrapDns("nope.example.com");
    expect(peers).toEqual([]);
  });

  it("retries on transient errors", async () => {
    const transientErr = Object.assign(new Error("DNS timeout"), { code: "ETIMEOUT" });

    mockResolveTxt
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce([["dnsaddr=/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest1"]]);

    const peers = await resolveBootstrapDns("flaky.example.com");
    expect(peers).toEqual(["/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest1"]);
    expect(mockResolveTxt).toHaveBeenCalledTimes(2);
  });

  it("returns empty after all retries exhausted", async () => {
    const err = Object.assign(new Error("DNS timeout"), { code: "ETIMEOUT" });
    mockResolveTxt.mockRejectedValue(err);

    const peers = await resolveBootstrapDns("dead.example.com");
    expect(peers).toEqual([]);
    expect(mockResolveTxt).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("returns empty when no dnsaddr records found", async () => {
    mockResolveTxt.mockResolvedValue([["v=spf1 include:example.com ~all"]]);

    const peers = await resolveBootstrapDns("no-peers.example.com");
    expect(peers).toEqual([]);
  });

  it("rejects multiaddresses that don't start with /", async () => {
    mockResolveTxt.mockResolvedValue([
      ["dnsaddr=not-a-multiaddr"],
      ["dnsaddr=/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWGood"],
    ]);

    const peers = await resolveBootstrapDns("mixed.example.com");
    expect(peers).toEqual(["/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWGood"]);
  });
});

describe("mergeBootstrapPeers", () => {
  it("merges config and DNS peers", () => {
    const merged = mergeBootstrapPeers(
      ["/ip4/1.1.1.1/tcp/4001/p2p/PeerA"],
      ["/ip4/2.2.2.2/tcp/4001/p2p/PeerB"],
    );
    expect(merged).toEqual(["/ip4/1.1.1.1/tcp/4001/p2p/PeerA", "/ip4/2.2.2.2/tcp/4001/p2p/PeerB"]);
  });

  it("deduplicates identical multiaddresses", () => {
    const addr = "/ip4/1.1.1.1/tcp/4001/p2p/PeerA";
    const merged = mergeBootstrapPeers([addr], [addr]);
    expect(merged).toEqual([addr]);
  });

  it("handles undefined config peers", () => {
    const merged = mergeBootstrapPeers(undefined, ["/ip4/1.1.1.1/tcp/4001/p2p/PeerA"]);
    expect(merged).toEqual(["/ip4/1.1.1.1/tcp/4001/p2p/PeerA"]);
  });

  it("handles empty DNS peers", () => {
    const merged = mergeBootstrapPeers(["/ip4/1.1.1.1/tcp/4001/p2p/PeerA"], []);
    expect(merged).toEqual(["/ip4/1.1.1.1/tcp/4001/p2p/PeerA"]);
  });

  it("handles both empty", () => {
    const merged = mergeBootstrapPeers(undefined, []);
    expect(merged).toEqual([]);
  });

  it("preserves order: config peers first, then DNS peers", () => {
    const merged = mergeBootstrapPeers(
      ["/ip4/1.1.1.1/tcp/4001/p2p/Config"],
      ["/ip4/2.2.2.2/tcp/4001/p2p/Dns"],
    );
    expect(merged[0]).toContain("Config");
    expect(merged[1]).toContain("Dns");
  });
});
