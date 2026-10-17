import { describe, it, expect } from "vitest";
import {
  parseSoapboxConnection,
  verifySoapboxConnection,
  soapboxOperatorEnvironment,
} from "./soapbox-connection.js";
const connection = {
  version: 1,
  role: "operator",
  id: "test-worker",
  url: "https://compute.example",
  token: "a".repeat(64),
  address: `0x${"1".repeat(40)}`,
  chain_id: 84532,
  escrow: `0x${"2".repeat(40)}`,
  escrow_code_sha256: "a".repeat(64),
  rpc_url: "https://sepolia.base.org",
};
describe("participant enrollment", () => {
  it("rejects mainnet and credential leaks in transport URLs", () => {
    for (const patch of [
      { chain_id: 8453 },
      { url: "http://remote.example" },
      { url: "https://user:password@example.com" },
      { rpc_url: "https://provider.example/v2/private-provider-key" },
      { rpc_url: "https://sepolia.base.org?api-key=private-provider-key" },
      { address: `0x${"0".repeat(40)}` },
    ])
      expect(() => parseSoapboxConnection({ ...connection, ...patch })).toThrow();
  });
  it("pins worker identity, role and payout address", () => {
    const parsed = parseSoapboxConnection(connection);
    const status = {
      enabled: true,
      principal: { id: parsed.id, roles: ["worker"], pools: [], projects: [] },
      payment_account: { chain_id: 84532, address: parsed.address },
    };
    expect(() => verifySoapboxConnection(parsed, status)).not.toThrow();
    for (const patch of [
      { principal: { ...status.principal, id: "other" } },
      { principal: { ...status.principal, roles: ["worker", "admin"] } },
      { payment_account: { chain_id: 84532, address: `0x${"3".repeat(40)}` } },
    ])
      expect(() => verifySoapboxConnection(parsed, { ...status, ...patch })).toThrow();
  });
  it("does not send buyer or wallet secrets to the worker process", () => {
    expect(
      soapboxOperatorEnvironment("worker-token", {
        PATH: "/bin",
        HOME: "/home/operator",
        CDP_WALLET_SECRET: "secret",
        BITTERBOT_SOAPBOX_TOKEN: "buyer-token",
        PRIVATE_KEY: "key",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/operator", SOAPBOX_WORKER_TOKEN: "worker-token" });
  });
});
