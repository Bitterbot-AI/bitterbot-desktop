import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createSoapboxSetupHandlers } from "../gateway/server-methods/soapbox-setup.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { SoapboxClient, type SoapboxStatus } from "../infra/soapbox-client.js";
import { LocalOperatorService } from "./soapbox-local-operator.js";
import { SOAPBOX_SETUP_RELEASE } from "./soapbox-setup-runtime.js";
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
  await setup.stop();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
describe("Compute onboarding", () => {
  it("saves buyer profiles, switches back without touching the main wallet, and rechecks revocation", async () => {
    const original = JSON.parse(await readFile(configPath, "utf8"));
    await setup.import(connection, "buyer");
    await setup.activate();
    await setup.stop();
    setup = new SoapboxSetup({ root: directory, configPath, configuredRole: "participant" });
    const first = (await setup.status()).profiles![0];
    coordinatorStatus.mockResolvedValue({
      principal: { id: "tester-2", roles: ["submitter"] },
      payment_account: { chain_id: 84532, address },
      active_jobs: 0,
    } as SoapboxStatus);
    await setup.mutate(() => setup.newProfile(), true);
    await setup.mutate(() => setup.import({ ...connection, id: "tester-2" }, "buyer"));
    expect((await setup.status()).addingProfile).toBe(true);
    // Wallet, preparation and import do not replace the running profile.
    expect((await setup.status()).profiles!.find((p) => p.id === first.id)?.active).toBe(true);
    await setup.activate();
    await setup.stop();
    setup = new SoapboxSetup({ root: directory, configPath, configuredRole: "participant" });
    const before = await readFile(configPath, "utf8");
    coordinatorStatus.mockRejectedValueOnce(new Error("revoked"));
    await expect(setup.switchProfile(first.id)).rejects.toThrow("revoked");
    expect(await readFile(configPath, "utf8")).toBe(before);
    coordinatorStatus.mockResolvedValue({
      principal: { id: "tester", roles: ["submitter"] },
      payment_account: { chain_id: 84532, address },
      active_jobs: 0,
    } as SoapboxStatus);
    await setup.switchProfile(first.id);
    expect((await setup.status()).profiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: first.id, active: true })]),
    );
    const after = JSON.parse(await readFile(configPath, "utf8"));
    expect(after.tools).toEqual(original.tools);
    expect(after.channels).toEqual(original.channels);
    const registry = await readFile(path.join(directory, "profiles.json"), "utf8");
    expect(registry).not.toMatch(/main-wallet|cccccccc|private-secret|private-key/);
  });
  it("blocks profile changes with pending payments, unknown counts, or an offline coordinator", async () => {
    await setup.import(connection, "buyer");
    await setup.activate();
    await setup.stop();
    setup = new SoapboxSetup({ root: directory, configPath, configuredRole: "participant" });
    const first = (await setup.status()).profiles![0];
    const before = await readFile(configPath, "utf8");
    for (const count of [1, undefined]) {
      coordinatorStatus.mockResolvedValue({
        principal: { id: "tester", roles: ["submitter"] },
        payment_account: { chain_id: 84532, address },
        active_jobs: count,
        jobs: [],
      } as SoapboxStatus);
      await expect(setup.switchProfile(first.id)).rejects.toThrow(
        count ? "pending payments" : "active-job count",
      );
      expect(await readFile(configPath, "utf8")).toBe(before);
    }
    coordinatorStatus.mockRejectedValue(new Error("offline"));
    await expect(setup.switchProfile(first.id)).rejects.toThrow("offline");
    expect(await readFile(configPath, "utf8")).toBe(before);
    await expect(setup.switchProfile("../bad")).rejects.toThrow("profile ID");
  });
  it("creates a verified local operator without enrollment and preserves wallet settings", async () => {
    const original = JSON.parse(await readFile(configPath, "utf8"));
    const archive = path.join(directory, "runtime.tar.gz");
    await writeFile(archive, Buffer.alloc(SOAPBOX_SETUP_RELEASE.bytes));
    const local = new SoapboxSetup({ root: directory, configPath, bundledRuntimeArchive: archive });
    const worker = path.join(directory, "verified-worker.json");
    await writeFile(
      worker,
      JSON.stringify({ sandbox: { image: "verified" }, allow_unsafe_host: false }),
    );
    vi.spyOn(local.runtime, "begin").mockResolvedValue({ id: "test", offset: 0 });
    vi.spyOn(local.runtime, "chunk").mockResolvedValue({ offset: 0 });
    vi.spyOn(local.runtime, "prepare").mockImplementation(async () => {
      local.runtime.ready = { binary: path.join(directory, "soapbox"), worker };
      local.runtime.progress = { state: "ready", message: "verified", percent: 100 };
    });
    vi.spyOn(LocalOperatorService.prototype, "start").mockResolvedValue();
    vi.spyOn(LocalOperatorService.prototype, "waitForGpu").mockResolvedValue();
    vi.spyOn(LocalOperatorService.prototype, "stop").mockResolvedValue();
    await local.mutate(() => local.enableLocalOperator());
    await expect(local.mutate(() => local.enableLocalOperator())).rejects.toThrow("in progress");
    await local.waitForLocalSetup();
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.tools).toEqual(original.tools);
    expect(config.channels).toEqual(original.channels);
    expect(config.p2p.enabled).toBe(true);
    expect(config.plugins.entries["soapbox-compute"]).toMatchObject({
      enabled: true,
      config: { mode: "mesh-operator" },
    });
    expect((await local.status()).configuredRole).toBe("mesh-operator");
    await local.stop();
  });
  it("keeps configuration intact when one-click runtime verification fails", async () => {
    const before = await readFile(configPath, "utf8");
    const archive = path.join(directory, "damaged.tar.gz");
    await writeFile(archive, "damaged");
    const local = new SoapboxSetup({ root: directory, configPath, bundledRuntimeArchive: archive });
    await local.mutate(() => local.enableLocalOperator());
    await expect(local.waitForLocalSetup()).rejects.toThrow("damaged");
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect((await local.status()).progress.state).toBe("failed");
  });
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
  it("does not prepare a bundled runtime before operator enrollment or with damaged bytes", async () => {
    const archive = path.join(directory, "runtime.tar.gz");
    await writeFile(archive, "damaged");
    const bundled = new SoapboxSetup({
      root: directory,
      configPath,
      bundledRuntimeArchive: archive,
    });
    await expect(bundled.prepareBundledRuntime()).rejects.toThrow("operator enrollment");
    coordinatorStatus.mockResolvedValue({
      principal: { id: "tester", roles: ["worker"] },
      payment_account: { chain_id: 84532, address },
    } as SoapboxStatus);
    await bundled.import({ ...connection, role: "operator" }, "operator");
    await expect(bundled.prepareBundledRuntime()).rejects.toThrow("damaged");
  });
});
