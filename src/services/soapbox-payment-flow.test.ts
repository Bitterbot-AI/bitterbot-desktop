import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SoapboxPaymentQuote } from "../infra/soapbox-client.js";
import { fundSoapboxEscrow } from "./soapbox-payment.js";

const fake = vi.hoisted(() => ({
  chain: vi.fn(),
  code: vi.fn(),
  read: vi.fn(),
  receipt: vi.fn(),
  escrow: `0x${"2".repeat(40)}`,
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
}));
vi.mock("viem", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createPublicClient: () => ({
    getChainId: fake.chain,
    getCode: fake.code,
    readContract: fake.read,
    waitForTransactionReceipt: fake.receipt,
  }),
}));
vi.mock("../infra/soapbox-payment-policy.js", async () => {
  const { createHash } = await import("node:crypto");
  return {
    SOAPBOX_PAYMENT_POLICY: {
      chainId: 84532,
      escrow: fake.escrow,
      codeSha256: createHash("sha256").update(Buffer.from("6000", "hex")).digest("hex"),
    },
  };
});
const quote = (): SoapboxPaymentQuote => ({
  chain_id: 84532,
  token: fake.token,
  escrow: fake.escrow,
  buyer: `0x${"1".repeat(40)}`,
  operator: `0x${"3".repeat(40)}`,
  key: `0x${"a".repeat(64)}`,
  amount_microusdc: 2000,
  expires: Math.floor(Date.now() / 1000) + 3600,
});
beforeEach(() => {
  vi.resetAllMocks();
  fake.chain.mockResolvedValue(84532);
  fake.code.mockResolvedValue("0x6000");
  fake.read.mockImplementation(async ({ functionName }) =>
    functionName === "token" ? fake.token : ["0x0", "0x0", 0n, 0n, 0n, `0x${"0".repeat(64)}`],
  );
  fake.receipt.mockResolvedValue({ status: "success" });
});
function options() {
  const payment = quote();
  return {
    quote: payment,
    buyer: payment.buyer,
    network: "base-sepolia",
    env: {},
    reserve: vi.fn(async () => {}),
    send: vi.fn<Parameters<typeof fundSoapboxEscrow>[0]["send"]>(async () => `0x${"b".repeat(64)}`),
  };
}
describe("Compute escrow funding sequence", () => {
  it("reserves before approval and waits for approval confirmation before funding", async () => {
    const request = options(),
      order: string[] = [];
    request.reserve.mockImplementation(async () => {
      order.push("reserve");
    });
    request.send.mockImplementation(async (transaction) => {
      order.push(transaction.to === fake.token ? "approve" : "fund");
      return `0x${"b".repeat(64)}` as `0x${string}`;
    });
    fake.receipt.mockImplementation(async () => {
      order.push("confirmed");
      return { status: "success" };
    });
    expect((await fundSoapboxEscrow(request)).status).toBe("funded");
    expect(order).toEqual(["reserve", "approve", "confirmed", "fund", "confirmed"]);
    expect(fake.receipt).toHaveBeenCalledWith(
      expect.objectContaining({ confirmations: 2, timeout: 45000 }),
    );
    expect(request.send.mock.calls.every(([transaction]) => transaction.value === 0n)).toBe(true);
  });
  it.each(["chain", "bytecode", "token", "unapproved escrow"])(
    "rejects %s before reserving or signing",
    async (failure) => {
      const request = options();
      if (failure === "chain") fake.chain.mockResolvedValue(8453);
      if (failure === "bytecode") fake.code.mockResolvedValue("0x6001");
      if (failure === "token") fake.read.mockResolvedValue(`0x${"9".repeat(40)}`);
      if (failure === "unapproved escrow") request.quote.escrow = `0x${"8".repeat(40)}`;
      await expect(fundSoapboxEscrow(request)).rejects.toThrow();
      expect(request.reserve).not.toHaveBeenCalled();
      expect(request.send).not.toHaveBeenCalled();
    },
  );
  it.each(["reverted", "timeout"])("does not fund after approval %s", async (failure) => {
    const request = options();
    if (failure === "reverted") fake.receipt.mockResolvedValue({ status: "reverted" });
    else fake.receipt.mockRejectedValue(new Error("receipt timed out"));
    await expect(fundSoapboxEscrow(request)).rejects.toThrow();
    expect(request.reserve).toHaveBeenCalledTimes(1);
    expect(request.send).toHaveBeenCalledTimes(1);
  });
});
