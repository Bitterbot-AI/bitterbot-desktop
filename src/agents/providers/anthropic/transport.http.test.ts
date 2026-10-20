import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAnthropicStreamFn, resetAnthropicRuntimeState } from "./index.js";
import { makeModel, messageEnvelope, textEvents } from "./test-fixtures.js";

/**
 * Drives the in-tree provider through the REAL @anthropic-ai/sdk client
 * (default transport) against a local HTTP server, so an SDK upgrade that
 * changes the request it sends or how it parses the SSE stream fails here.
 */

type Captured = { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };

let server: http.Server;
let baseUrl = "";
const captured: Captured[] = [];
let respond: (res: http.ServerResponse) => void = () => {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      captured.push({
        url: req.url ?? "",
        headers: req.headers,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured.length = 0;
  resetAnthropicRuntimeState();
});

function sseResponse(res: http.ServerResponse, events: Array<{ type: string }>): void {
  res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test" });
  for (const event of events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

const context: Context = {
  systemPrompt: "You are a test.",
  messages: [{ role: "user", content: "say hello", timestamp: 1 }],
};

async function run(apiKey: string): Promise<AssistantMessage> {
  const streamFn = createAnthropicStreamFn(undefined);
  const stream = await streamFn(makeModel({ id: "claude-opus-4-8", baseUrl }), context, {
    apiKey,
    maxTokens: 256,
  });
  return await stream.result();
}

describe("in-tree Anthropic provider over the real SDK transport", () => {
  it("sends the expected request and parses a streamed reply (API key)", async () => {
    respond = (res) =>
      sseResponse(
        res,
        messageEnvelope({
          body: textEvents(0, ["Hello", " world"]),
          deltaUsage: { output_tokens: 5 },
        }),
      );

    const message = await run("sk-ant-api03-test");

    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(message.usage.input).toBe(12);
    expect(message.usage.output).toBe(5);

    expect(captured).toHaveLength(1);
    const [req] = captured;
    expect(req.url).toBe("/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-ant-api03-test");
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(String(req.headers["anthropic-beta"])).toContain(
      "fine-grained-tool-streaming-2025-05-14",
    );
    expect(req.body).toMatchObject({ model: "claude-opus-4-8", stream: true, max_tokens: 256 });
  });

  it("uses Bearer auth and Claude Code identity for OAuth setup tokens", async () => {
    respond = (res) => sseResponse(res, messageEnvelope({ body: textEvents(0, ["ok"]) }));

    const message = await run("sk-ant-oat01-test");

    expect(message.content).toEqual([{ type: "text", text: "ok" }]);
    const [req] = captured;
    expect(req.headers.authorization).toBe("Bearer sk-ant-oat01-test");
    expect(req.headers["x-api-key"]).toBeUndefined();
    const system = req.body.system as Array<{ text: string }>;
    expect(system[0]?.text).toContain("Claude Code");
  });

  it("surfaces an API error as an error result instead of throwing", async () => {
    respond = (res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "max_tokens: too large" },
        }),
      );
    };

    const message = await run("sk-ant-api03-test");

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("max_tokens: too large");
  });
});
