import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";

async function withTempConfig(run: () => Promise<void>): Promise<void> {
  const prevConfigPath = process.env.BITTERBOT_CONFIG_PATH;
  const prevDisableCache = process.env.BITTERBOT_DISABLE_CONFIG_CACHE;
  const dir = await mkdtemp(path.join(os.tmpdir(), "bitterbot-openai-disabled-test-"));
  const configPath = path.join(dir, "bitterbot.json");
  process.env.BITTERBOT_CONFIG_PATH = configPath;
  process.env.BITTERBOT_DISABLE_CONFIG_CACHE = "1";
  try {
    await writeFile(configPath, JSON.stringify({ gateway: { trustedProxies: [] } }), "utf-8");
    await run();
  } finally {
    if (prevConfigPath === undefined) {
      delete process.env.BITTERBOT_CONFIG_PATH;
    } else {
      process.env.BITTERBOT_CONFIG_PATH = prevConfigPath;
    }
    if (prevDisableCache === undefined) {
      delete process.env.BITTERBOT_DISABLE_CONFIG_CACHE;
    } else {
      process.env.BITTERBOT_DISABLE_CONFIG_CACHE = prevDisableCache;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function createRequest(pathname: string, method = "POST"): IncomingMessage {
  return {
    method,
    url: pathname,
    headers: { host: "localhost:19001", "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

function createResponse() {
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    end: vi.fn((chunk?: unknown) => {
      body = typeof chunk === "string" ? chunk : chunk == null ? "" : JSON.stringify(chunk);
    }),
  } as unknown as ServerResponse;
  return { res, headers, getBody: () => body };
}

async function dispatch(
  server: ReturnType<typeof createGatewayHttpServer>,
  req: IncomingMessage,
  res: ServerResponse,
) {
  server.emit("request", req, res);
  await new Promise((resolve) => setImmediate(resolve));
}

const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token",
  password: undefined,
  allowTailscale: false,
};

describe("gateway HTTP: disabled OpenAI-style endpoints", () => {
  test("a disabled /v1/chat/completions explains the config key instead of a bare 404", async () => {
    await withTempConfig(async () => {
      const server = createGatewayHttpServer({
        canvasHost: null,
        clients: new Set(),
        avatarBasePath: "/__control__",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        handleHooksRequest: async () => false,
        resolvedAuth,
      });
      const chat = createResponse();
      await dispatch(server, createRequest("/v1/chat/completions"), chat.res);
      expect(chat.res.statusCode).toBe(404);
      expect(chat.headers["content-type"]).toContain("application/json");
      const body = JSON.parse(chat.getBody()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("endpoint_disabled");
      expect(body.error.message).toContain("gateway.http.endpoints.chatCompletions.enabled");

      const responses = createResponse();
      await dispatch(server, createRequest("/v1/responses"), responses.res);
      expect(responses.res.statusCode).toBe(404);
      expect(responses.getBody()).toContain("gateway.http.endpoints.responses.enabled");

      // Unrelated paths keep the plain fallthrough.
      const other = createResponse();
      await dispatch(server, createRequest("/v1/embeddings"), other.res);
      expect(other.res.statusCode).toBe(404);
      expect(other.getBody()).toBe("Not Found");
    });
  });

  test("an enabled /v1/chat/completions is served by the real handler", async () => {
    await withTempConfig(async () => {
      const server = createGatewayHttpServer({
        canvasHost: null,
        clients: new Set(),
        avatarBasePath: "/__control__",
        openAiChatCompletionsEnabled: true,
        openResponsesEnabled: false,
        handleHooksRequest: async () => false,
        resolvedAuth,
      });
      const chat = createResponse();
      // No bearer token: the real handler rejects with 401, which proves the
      // disabled-endpoint hint stayed out of the way.
      await dispatch(server, createRequest("/v1/chat/completions"), chat.res);
      expect(chat.res.statusCode).toBe(401);
      expect(chat.getBody()).not.toContain("endpoint_disabled");
    });
  });
});
