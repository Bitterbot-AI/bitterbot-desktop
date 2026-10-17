import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { createSoapboxSetupHandlers } from "../gateway/server-methods/soapbox-setup.js";
import { SoapboxClient, type SoapboxStatus } from "../infra/soapbox-client.js";
import { SoapboxSetup } from "./soapbox-setup.js";

const address = `0x${"1".repeat(40)}`;
vi.mock("./soapbox-wallet.js", () => ({
  soapboxWalletIdentity: async () => `0x${"1".repeat(40)}`,
  soapboxWalletAuthentication: async () => ({
    apiKeyId: "private-id",
    apiKeySecret: "private-key",
    walletSecret: "private-secret",
  }),
  initializeSoapboxWallet: vi.fn(async () => `0x${"1".repeat(40)}`),
}));
const connection = {
  version: 1,
  role: "buyer",
  id: "tester",
  url: "http://127.0.0.1:8787",
  token: "c".repeat(64),
  address,
  chain_id: 84532,
  escrow: `0x${"2".repeat(40)}`,
  escrow_code_sha256: "a".repeat(64),
  rpc_url: "https://sepolia.base.org",
};
let directory: string;
let configPath: string;
let setup: SoapboxSetup;
let coordinatorStatus: MockInstance<SoapboxClient["status"]>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "soapbox-gui-test-"));
  configPath = path.join(directory, "bitterbot.json");
  await writeFile(
    configPath,
    JSON.stringify({
      tools: { wallet: { enabled: true, network: "base", walletStorePath: "/main-wallet" } },
      channels: { telegram: { enabled: true } },
    }),
  );
  setup = new SoapboxSetup({ root: directory, configPath });
  coordinatorStatus = vi.spyOn(SoapboxClient.prototype, "status").mockResolvedValue({
    principal: { id: "tester", roles: ["submitter"] },
    payment_account: { chain_id: 84532, address },
  } as SoapboxStatus);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
describe("Compute onboarding", () => {
  it("activates a verified buyer while preserving main wallet and channel settings", async () => {
    const before = JSON.parse(await readFile(configPath, "utf8"));
    await setup.import({ ...connection, extra: "must-not-persist" }, "buyer");
    const status = await setup.status();
    expect(JSON.stringify(status)).not.toMatch(/private-secret|private-key|cccccccc/);
    await setup.activate();
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.tools).toEqual(before.tools);
    expect(config.channels).toEqual(before.channels);
    const state = config.plugins.entries["soapbox-compute"].config.stateDirectory;
    expect(JSON.parse(await readFile(path.join(state, "connection.json"), "utf8"))).toEqual(
      connection,
    );
    expect(JSON.parse(await readFile(path.join(state, "bitterbot.before.json"), "utf8"))).toEqual(
      before,
    );
    await expect(setup.mutate(() => setup.wallet(undefined))).rejects.toThrow("already has");
  });
  it("rejects mainnet, mismatched buyer wallets, wrong roles, and admin enrollments", async () => {
    await expect(setup.import({ ...connection, chain_id: 8453 }, "buyer")).rejects.toThrow(
      "Base Sepolia",
    );
    await expect(setup.import(connection, "operator")).rejects.toThrow("other role");
    coordinatorStatus.mockResolvedValue({
      principal: { id: "tester", roles: ["submitter", "admin"] },
      payment_account: { chain_id: 84532, address },
    } as SoapboxStatus);
    await expect(setup.import(connection, "buyer")).rejects.toThrow("verification failed");
    const other = `0x${"3".repeat(40)}`;
    coordinatorStatus.mockResolvedValue({
      principal: { id: "tester", roles: ["submitter"] },
      payment_account: { chain_id: 84532, address: other },
    } as SoapboxStatus);
    await expect(setup.import({ ...connection, address: other }, "buyer")).rejects.toThrow(
      "test wallet",
    );
  });
  it("does not activate operators before runtime verification or let them create buyer wallets", async () => {
    coordinatorStatus.mockResolvedValue({
      principal: { id: "tester", roles: ["worker"] },
      payment_account: { chain_id: 84532, address },
    } as SoapboxStatus);
    await setup.import({ ...connection, role: "operator" }, "operator");
    await expect(setup.activate()).rejects.toThrow("GPU runtime");
    await expect(setup.wallet(undefined)).rejects.toThrow("Operators");
  });
  it("preserves an existing pilot and rejects changes made by another setup", async () => {
    const active = new SoapboxSetup({ root: directory, configPath, configuredRole: "pilot" });
    await expect(active.mutate(() => active.import(connection, "buyer"))).rejects.toThrow(
      "already has",
    );
    await setup.import(connection, "buyer");
    await writeFile(
      configPath,
      JSON.stringify({
        plugins: { entries: { "soapbox-compute": { config: { mode: "pilot" } } } },
      }),
    );
    await expect(setup.activate()).rejects.toThrow("configured elsewhere");
  });
  it("requires an authenticated admin for every setup endpoint including reads", async () => {
    for (const handler of Object.values(createSoapboxSetupHandlers(setup))) {
      for (const client of [
        null,
        { connect: { role: "node", scopes: ["operator.admin"] } },
        { connect: { role: "operator", scopes: ["operator.write", "operator.read"] } },
      ]) {
        const respond = vi.fn();
        await handler({ client, respond, params: {} } as GatewayRequestHandlerOptions);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: "Compute setup requires operator.admin" }),
        );
      }
    }
    const respond = vi.fn();
    await createSoapboxSetupHandlers(setup)["soapbox.setup.status"]({
      client: { connect: { role: "operator", scopes: ["operator.admin"] } },
      respond,
      params: {},
    } as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ configured: false }));
  });
});
