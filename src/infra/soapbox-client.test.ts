import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SoapboxClient, soapboxClientFromEnv } from "./soapbox-client.js";

const token = "test-token-00000000000000000000000000";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function serve(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return `http://127.0.0.1:${address.port}`;
}

describe("Soapbox client", () => {
  it("is disabled until explicitly enabled", () => {
    expect(soapboxClientFromEnv({})).toBeNull();
    expect(() => soapboxClientFromEnv({ BITTERBOT_SOAPBOX_ENABLED: "1" })).toThrow("TOKEN");
  });
  it("rejects remote plaintext, embedded credentials and paths", () => {
    for (const url of [
      "http://example.com",
      "https://u:p@example.com",
      "https://example.com/private",
    ]) {
      expect(() => new SoapboxClient(url, token)).toThrow();
    }
  });
  it("authenticates on the server side and checks protocol version", async () => {
    const url = await serve((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ api_version: 1, settlement: "test_credits" }));
    });
    expect(await new SoapboxClient(url, token).status()).toMatchObject({
      enabled: true,
      api_version: 1,
    });
  });
  it("does not forward credentials through redirects", async () => {
    let leaked = false;
    const destination = await serve((_req, res) => {
      leaked = true;
      res.end("{}");
    });
    const source = await serve((_req, res) => {
      res.writeHead(302, { Location: destination });
      res.end();
    });
    await expect(new SoapboxClient(source, token).status()).rejects.toThrow();
    expect(leaked).toBe(false);
  });
  it("preserves application errors and disallows path injection", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(400);
      res.end('{"error":"insufficient test credits"}');
    });
    const client = new SoapboxClient(url, token);
    await expect(client.request("POST", "/v1/jobs", {})).rejects.toThrow(
      "insufficient test credits",
    );
    await expect(client.request("GET", "//other-host/v1/jobs")).rejects.toThrow("path");
  });
});
