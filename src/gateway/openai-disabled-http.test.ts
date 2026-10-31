import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createDisabledOpenAiEndpointHandler,
  describeDisabledOpenAiEndpoint,
  OPENAI_ENDPOINT_DISABLED_CODE,
} from "./openai-disabled-http.js";

function fakeReq(url: string, method = "POST"): IncomingMessage {
  return { url, method, headers: {} } as unknown as IncomingMessage;
}

function fakeRes() {
  const headers: Record<string, string> = {};
  const state = { statusCode: 0, body: "", headers };
  const res = {
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(value: number) {
      state.statusCode = value;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      state.body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { res, state };
}

describe("disabled OpenAI-style endpoints", () => {
  it("answers a disabled chat completions request with an OpenAI-shaped hint", () => {
    const warn = vi.fn();
    const handle = createDisabledOpenAiEndpointHandler({
      chatCompletionsEnabled: false,
      responsesEnabled: false,
      warn,
    });
    const { res, state } = fakeRes();
    expect(handle(fakeReq("/v1/chat/completions?x=1"), res)).toBe(true);
    expect(state.statusCode).toBe(404);
    expect(state.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(state.body) as {
      error: { message: string; type: string; code: string; param: null };
    };
    expect(body.error.code).toBe(OPENAI_ENDPOINT_DISABLED_CODE);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.param).toBeNull();
    expect(body.error.message).toContain("gateway.http.endpoints.chatCompletions.enabled");
    expect(body.error.message).toContain("docs.bitterbot.ai/gateway/openai-http-api");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("/v1/chat/completions");
    expect(warn.mock.calls[0]?.[0]).toContain("chatCompletions.enabled=true");
  });

  it("warns once per endpoint, not once per request", () => {
    const warn = vi.fn();
    const handle = createDisabledOpenAiEndpointHandler({
      chatCompletionsEnabled: false,
      responsesEnabled: false,
      warn,
    });
    for (let i = 0; i < 3; i += 1) {
      expect(handle(fakeReq("/v1/chat/completions"), fakeRes().res)).toBe(true);
    }
    expect(handle(fakeReq("/v1/responses"), fakeRes().res)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("names the responses config key for /v1/responses", () => {
    const handle = createDisabledOpenAiEndpointHandler({
      chatCompletionsEnabled: true,
      responsesEnabled: false,
      warn: () => {},
    });
    const { res, state } = fakeRes();
    expect(handle(fakeReq("/v1/responses"), res)).toBe(true);
    const body = JSON.parse(state.body) as { error: { message: string } };
    expect(body.error.message).toContain("gateway.http.endpoints.responses.enabled");
    expect(body.error.message).toContain("openresponses-http-api");
  });

  it("stays out of the way when the endpoint is enabled or the path is unknown", () => {
    const warn = vi.fn();
    const handle = createDisabledOpenAiEndpointHandler({
      chatCompletionsEnabled: true,
      responsesEnabled: true,
      warn,
    });
    expect(handle(fakeReq("/v1/chat/completions"), fakeRes().res)).toBe(false);
    expect(handle(fakeReq("/v1/responses"), fakeRes().res)).toBe(false);
    const disabledHandle = createDisabledOpenAiEndpointHandler({
      chatCompletionsEnabled: false,
      responsesEnabled: false,
      warn,
    });
    expect(disabledHandle(fakeReq("/v1/models", "GET"), fakeRes().res)).toBe(false);
    expect(disabledHandle(fakeReq("/healthz", "GET"), fakeRes().res)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("describes only the endpoints it knows", () => {
    expect(describeDisabledOpenAiEndpoint("/v1/chat/completions")?.configKey).toBe(
      "gateway.http.endpoints.chatCompletions.enabled",
    );
    expect(describeDisabledOpenAiEndpoint("/v1/embeddings")).toBeNull();
  });
});
