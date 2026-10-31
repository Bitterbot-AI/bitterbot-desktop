import type { IncomingMessage, ServerResponse } from "node:http";
import { logWarn } from "../logger.js";
import { sendJson } from "./http-common.js";

/**
 * Explains, instead of a bare 404, why an OpenAI-style HTTP endpoint that the
 * Gateway knows about is not being served.
 *
 * Both `/v1/chat/completions` and `/v1/responses` are off by default. An
 * integrator who points an OpenAI SDK at the Gateway otherwise sees only
 * `404 Not Found`, concludes the API is incompatible, and leaves (a robotics
 * project did exactly that in 2026-10). The response here keeps the 404 status,
 * since the route really is not mounted, but carries an OpenAI-shaped error
 * body that names the config key to flip and the docs page, and the gateway log
 * says the same thing once per endpoint so the operator sees it too.
 */

export const OPENAI_ENDPOINT_DISABLED_CODE = "endpoint_disabled";

export type DisabledOpenAiEndpointOptions = {
  chatCompletionsEnabled: boolean;
  responsesEnabled: boolean;
  /** Test seam; defaults to the gateway warn log. */
  warn?: (message: string) => void;
};

type KnownEndpoint = {
  pathname: string;
  label: string;
  configKey: string;
  docsUrl: string;
  enabled: (opts: DisabledOpenAiEndpointOptions) => boolean;
};

const KNOWN_ENDPOINTS: readonly KnownEndpoint[] = [
  {
    pathname: "/v1/chat/completions",
    label: "OpenAI Chat Completions",
    configKey: "gateway.http.endpoints.chatCompletions.enabled",
    docsUrl: "https://docs.bitterbot.ai/gateway/openai-http-api",
    enabled: (opts) => opts.chatCompletionsEnabled,
  },
  {
    pathname: "/v1/responses",
    label: "OpenResponses",
    configKey: "gateway.http.endpoints.responses.enabled",
    docsUrl: "https://docs.bitterbot.ai/gateway/openresponses-http-api",
    enabled: (opts) => opts.responsesEnabled,
  },
];

export function describeDisabledOpenAiEndpoint(pathname: string): {
  label: string;
  configKey: string;
  docsUrl: string;
  message: string;
} | null {
  const endpoint = KNOWN_ENDPOINTS.find((candidate) => candidate.pathname === pathname);
  if (!endpoint) {
    return null;
  }
  const message =
    `The ${endpoint.label} endpoint (${endpoint.pathname}) is disabled on this Bitterbot Gateway. ` +
    `Set ${endpoint.configKey} to true in bitterbot.json ` +
    `(bitterbot config set ${endpoint.configKey} true --json) and restart the Gateway. ` +
    `Docs: ${endpoint.docsUrl}`;
  return {
    label: endpoint.label,
    configKey: endpoint.configKey,
    docsUrl: endpoint.docsUrl,
    message,
  };
}

/**
 * Returns a request handler that answers requests for a known-but-disabled
 * OpenAI-style endpoint and returns `false` for everything else. Mount it after
 * the enabled handlers and before the generic 404 fallthrough.
 */
export function createDisabledOpenAiEndpointHandler(
  opts: DisabledOpenAiEndpointOptions,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const warn = opts.warn ?? logWarn;
  const warned = new Set<string>();
  return (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const endpoint = KNOWN_ENDPOINTS.find((candidate) => candidate.pathname === pathname);
    if (!endpoint || endpoint.enabled(opts)) {
      return false;
    }
    const described = describeDisabledOpenAiEndpoint(pathname);
    if (!described) {
      return false;
    }
    if (!warned.has(pathname)) {
      warned.add(pathname);
      warn(
        `[gateway/http] ${req.method ?? "GET"} ${pathname} refused: ${described.label} endpoint is disabled; ` +
          `set ${described.configKey}=true to serve it (${described.docsUrl})`,
      );
    }
    sendJson(res, 404, {
      error: {
        message: described.message,
        type: "invalid_request_error",
        param: null,
        code: OPENAI_ENDPOINT_DISABLED_CODE,
      },
    });
    return true;
  };
}
