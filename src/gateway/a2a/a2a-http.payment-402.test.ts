import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resetWalletDiscovery, setLocalWalletCapability } from "../../infra/wallet-discovery.js";
import { createA2aHttpHandler } from "./a2a-http.js";

// PLAN-29 Phase 0.2: when the payment gate 402s an unpaid message/send, the
// advertised requirements must be payable. payTo has to use the same fallback
// chain as verification (configured address, else live wallet capability) and
// network/asset must reflect the node's actual network — otherwise an
// auto-derived-address node advertises payTo:"" (buyer has nowhere to send)
// or a sepolia node advertises the mainnet USDC contract (payment can never
// verify).

function mockReq(opts: { body?: unknown }): IncomingMessage {
  const sock = new Socket();
  Object.defineProperty(sock, "remoteAddress", { value: "127.0.0.1", writable: true });
  const req = new IncomingMessage(sock);
  req.method = "POST";
  req.url = "/a2a";
  req.headers = { "content-type": "application/json" };
  const buf = Buffer.from(JSON.stringify(opts.body));
  req.push(buf);
  req.push(null);
  req.headers["content-length"] = String(buf.byteLength);
  return req;
}

function mockRes(): ServerResponse & { _body?: string; _headers: Record<string, string> } {
  const sock = new Socket();
  const res = new ServerResponse(new IncomingMessage(sock)) as ServerResponse & {
    _body?: string;
    _headers: Record<string, string>;
  };
  res._headers = {};
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: string | number | readonly string[]) => {
    res._headers[name.toLowerCase()] = String(value);
    return origSetHeader(name, value as string);
  }) as typeof res.setHeader;
  let buf = "";
  res.write = ((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: string | Uint8Array) => {
    if (chunk) buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    res._body = buf;
    return res;
  }) as typeof res.end;
  return res;
}

const WALLET_ADDR = "0x00000000000000000000000000000000DeaDBeef";

function makeHandler(config: Record<string, unknown>) {
  return createA2aHttpHandler({
    getConfig: () => config as never,
    getSkills: () => [],
    getGatewayUrl: () => "http://127.0.0.1:19001",
    getSkillsVersion: () => 0,
    taskDb: new DatabaseSync(":memory:"),
  });
}

function sendBody() {
  return {
    jsonrpc: "2.0",
    method: "message/send",
    params: { message: { role: "user", parts: [{ type: "text", text: "hi" }] } },
    id: "pay-1",
  };
}

async function get402Requirements(config: Record<string, unknown>) {
  const h = makeHandler(config);
  const req = mockReq({ body: sendBody() });
  const res = mockRes();
  await h.handle(req, res, { auth: {} as never, trustedProxies: [], rateLimiter: undefined });
  h.close();
  expect(res.statusCode).toBe(402);
  const header = res._headers["payment-required"];
  expect(header).toBeTruthy();
  const requirements = JSON.parse(Buffer.from(header, "base64").toString("utf-8"))[0];
  const body = JSON.parse(res._body ?? "{}");
  return { requirements, errorData: body.error?.data };
}

afterEach(() => {
  resetWalletDiscovery();
});

describe("A2A 402 payment requirements", () => {
  it("falls back to the live wallet address for payTo when no address is configured", async () => {
    setLocalWalletCapability({
      address: WALLET_ADDR,
      network: "base",
      acceptsPayments: true,
      updatedAt: Date.now(),
    });
    const { requirements, errorData } = await get402Requirements({
      a2a: { enabled: true, authentication: { type: "none" }, payment: { enabled: true } },
      tools: { wallet: { network: "base" } },
    });
    expect(requirements.payTo).toBe(WALLET_ADDR);
    expect(requirements.network).toBe("base");
    expect(requirements.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(errorData.payTo).toBe(WALLET_ADDR);
  });

  it("prefers the configured x402 address over the wallet fallback", async () => {
    setLocalWalletCapability({
      address: WALLET_ADDR,
      network: "base",
      acceptsPayments: true,
      updatedAt: Date.now(),
    });
    const configured = "0x1111111111111111111111111111111111111111";
    const { requirements } = await get402Requirements({
      a2a: {
        enabled: true,
        authentication: { type: "none" },
        payment: { enabled: true, x402: { address: configured } },
      },
      tools: { wallet: { network: "base" } },
    });
    expect(requirements.payTo).toBe(configured);
  });

  it("advertises the sepolia USDC asset when the node runs on base-sepolia", async () => {
    setLocalWalletCapability({
      address: WALLET_ADDR,
      network: "base-sepolia",
      acceptsPayments: true,
      updatedAt: Date.now(),
    });
    const { requirements, errorData } = await get402Requirements({
      a2a: { enabled: true, authentication: { type: "none" }, payment: { enabled: true } },
      tools: { wallet: { network: "base-sepolia" } },
    });
    expect(requirements.network).toBe("base-sepolia");
    expect(requirements.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(errorData.chain).toBe("base-sepolia");
  });
});
