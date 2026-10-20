import { afterEach, describe, expect, it, vi } from "vitest";
import { createSoapboxHandlers, soapboxHandlers } from "./soapbox.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const fake = vi.hoisted(() => ({
  request: vi.fn(),
  status: vi.fn(),
  enabled: true,
  wallet: vi.fn(),
  fund: vi.fn(),
}));
vi.mock("../../services/soapbox-wallet.js", () => ({
  createSoapboxWallet: fake.wallet,
  getSoapboxWalletStatus: vi.fn(),
}));
vi.mock("../../infra/soapbox-client.js", () => ({
  soapboxClientFromEnv: () => (fake.enabled ? fake : null),
}));
afterEach(() => {
  vi.clearAllMocks();
  fake.enabled = true;
});
async function invoke(method: string, params: Record<string, unknown>) {
  const respond = vi.fn();
  await soapboxHandlers[method]({
    params,
    respond,
    client: { connect: { role: "operator", scopes: ["operator.admin"] } },
  } as unknown as GatewayRequestHandlerOptions);
  return respond;
}
describe("Soapbox gateway adapter", () => {
  it("blocks operator wallet access and funding before creating a wallet", async () => {
    const handlers = createSoapboxHandlers(undefined, { role: "operator", client: fake as never });
    for (const method of [
      "soapbox.wallet",
      "soapbox.payment.fund",
      "soapbox.submit",
      "soapbox.cancel",
    ]) {
      const respond = vi.fn();
      await handlers[method]({
        params: { id: "job-1" },
        respond,
      } as unknown as GatewayRequestHandlerOptions);
      expect(respond.mock.calls[0][0]).toBe(false);
    }
    expect(fake.wallet).not.toHaveBeenCalled();
    expect(fake.fund).not.toHaveBeenCalled();
    expect(fake.request).not.toHaveBeenCalled();
  });
  it("funds through the dedicated wallet while the main wallet remains on Base", async () => {
    const main = { enabled: true, network: "base" as const, walletStorePath: "/mainnet" };
    const payment = { chain_id: 84532, amount_microusdc: 2000 };
    fake.wallet.mockResolvedValue({ fundSoapbox: fake.fund });
    fake.fund.mockResolvedValue({ status: "funded", txHash: "0xtest" });
    fake.request
      .mockResolvedValueOnce({ status: "awaiting_payment", payment })
      .mockResolvedValueOnce({ status: "queued" });
    const respond = vi.fn();
    await createSoapboxHandlers(main)["soapbox.payment.fund"]({
      params: { id: "job-1", approval: payment },
      client: { connect: { role: "operator", scopes: ["operator.admin"] } },
      respond,
    } as unknown as GatewayRequestHandlerOptions);
    expect(fake.wallet).toHaveBeenCalledWith(main, payment);
    expect(fake.fund).toHaveBeenCalledWith(payment);
    expect(main.network).toBe("base");
    expect(respond.mock.calls[0][0]).toBe(true);
  });
  it("requires admin and the reviewed quote before constructing a signing wallet", async () => {
    const payment = { chain_id: 84532, amount_microusdc: 2000 };
    fake.request.mockResolvedValue({ status: "awaiting_payment", payment });
    for (const scopes of [["operator.write"], ["operator.read"], []]) {
      await soapboxHandlers["soapbox.payment.fund"]({
        params: { id: "job-1", approval: payment },
        client: { connect: { role: "operator", scopes } },
        respond: vi.fn(),
      } as unknown as GatewayRequestHandlerOptions);
    }
    expect(fake.request).not.toHaveBeenCalled();
    await invoke("soapbox.payment.fund", { id: "job-1" });
    await invoke("soapbox.payment.fund", {
      id: "job-1",
      approval: { ...payment, amount_microusdc: 1 },
    });
    expect(fake.wallet).not.toHaveBeenCalled();
  });
  it("rejects backend and chat approvals even with admin scope", async () => {
    for (const [mode, via] of [
      ["backend", "gateway"],
      ["ui", "chat"],
    ]) {
      const respond = vi.fn();
      await soapboxHandlers["soapbox.payment.fund"]({
        params: { id: "job-1", approval: { amount_microusdc: 2000 }, via },
        client: { connect: { role: "operator", scopes: ["operator.admin"], client: { mode } } },
        respond,
      } as unknown as GatewayRequestHandlerOptions);
      expect(respond.mock.calls[0][0]).toBe(false);
    }
    expect(fake.request).not.toHaveBeenCalled();
    expect(fake.wallet).not.toHaveBeenCalled();
  });
  it("returns a disabled state without connecting", async () => {
    fake.enabled = false;
    const respond = await invoke("soapbox.status", {});
    expect(respond).toHaveBeenCalledWith(true, { enabled: false });
    expect(fake.request).not.toHaveBeenCalled();
  });
  it("forwards the original idempotency key and policy", async () => {
    const spec = { idempotency_key: "retry-1", mode: { kind: "paid", max_cost_credits: 10 } };
    fake.request.mockResolvedValue({ id: "job-1" });
    const respond = await invoke("soapbox.submit", spec);
    expect(fake.request).toHaveBeenCalledWith("POST", "/v1/jobs", spec);
    expect(respond).toHaveBeenCalledWith(true, { id: "job-1" });
  });
  it("rejects path injection before making an HTTP request", async () => {
    const respond = await invoke("soapbox.cancel", { id: "../credits" });
    expect(respond.mock.calls[0][0]).toBe(false);
    expect(fake.request).not.toHaveBeenCalled();
  });
  it("requires explicit boolean worker control", async () => {
    const respond = await invoke("soapbox.worker.pause", { id: "worker-1", paused: "false" });
    expect(respond.mock.calls[0][0]).toBe(false);
    expect(fake.request).not.toHaveBeenCalled();
  });
  it("only funds a quote fetched from the coordinator, never client-supplied payment fields", async () => {
    fake.request.mockResolvedValue({
      id: "job-1",
      status: "running",
      payment: { amount_microusdc: 1 },
    });
    const respond = await invoke("soapbox.payment.fund", {
      id: "job-1",
      payment: { amount_microusdc: 100000000 },
    });
    expect(fake.request).toHaveBeenCalledWith("GET", "/v1/jobs/job-1");
    expect(respond.mock.calls[0][0]).toBe(false);
  });
});
