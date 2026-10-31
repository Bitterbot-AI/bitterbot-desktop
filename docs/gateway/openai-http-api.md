---
summary: "Expose an OpenAI-compatible /v1/chat/completions HTTP endpoint from the Gateway"
read_when:
  - Integrating tools that expect OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

Bitterbot’s Gateway can serve a small OpenAI-compatible Chat Completions endpoint.

This endpoint is **disabled by default**. Enable it in config first.

- `POST /v1/chat/completions`
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

Under the hood, requests are executed as a normal Gateway agent run (same codepath as `bitterbot agent`), so routing/permissions/config match your Gateway.

## Authentication

Uses the Gateway auth configuration. Send a bearer token:

- `Authorization: Bearer <token>`

Notes:

- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `BITTERBOT_GATEWAY_TOKEN`).
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `BITTERBOT_GATEWAY_PASSWORD`).
- If `gateway.auth.rateLimit` is configured and too many auth failures occur, the endpoint returns `429` with `Retry-After`.

## Choosing an agent

No custom headers required: encode the agent id in the OpenAI `model` field:

- `model: "bitterbot:<agentId>"` (example: `"bitterbot:main"`, `"bitterbot:beta"`)
- `model: "agent:<agentId>"` (alias)

Or target a specific Bitterbot agent by header:

- `x-bitterbot-agent-id: <agentId>` (default: `main`)

Advanced:

- `x-bitterbot-session-key: <sessionKey>` to fully control session routing.

## Enabling the endpoint

Set `gateway.http.endpoints.chatCompletions.enabled` to `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

Or from the CLI, then restart the Gateway:

```bash
bitterbot config set gateway.http.endpoints.chatCompletions.enabled true --json
```

In Docker, run the same command through the container:

```bash
docker compose exec -u node bitterbot-gateway \
  node bitterbot.mjs config set gateway.http.endpoints.chatCompletions.enabled true --json
docker compose restart bitterbot-gateway
```

## Troubleshooting

### 404 with `"code": "endpoint_disabled"`

The Gateway is reachable but the endpoint is switched off. Since 1.12 the
response is a JSON error in the OpenAI shape that names the config key:

```json
{
  "error": {
    "message": "The OpenAI Chat Completions endpoint (/v1/chat/completions) is disabled on this Bitterbot Gateway. Set gateway.http.endpoints.chatCompletions.enabled to true in bitterbot.json (bitterbot config set gateway.http.endpoints.chatCompletions.enabled true --json) and restart the Gateway. Docs: https://docs.bitterbot.ai/gateway/openai-http-api",
    "type": "invalid_request_error",
    "param": null,
    "code": "endpoint_disabled"
  }
}
```

The gateway log carries the same line once per endpoint. Older Gateways
answered a plain `404 Not Found` with no hint, which read as "not an
OpenAI-compatible API". Enable the endpoint as shown above and retry.

### 401 Unauthorized

The endpoint is on but the request carried no (or the wrong) bearer token. Send
the Gateway token as `Authorization: Bearer <token>`; `bitterbot config get
gateway.auth.token` prints it.

## Disabling the endpoint

Set `gateway.http.endpoints.chatCompletions.enabled` to `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## Session behavior

By default the endpoint is **stateless per request** (a new session key is generated each call).

If the request includes an OpenAI `user` string, the Gateway derives a stable session key from it, so repeated calls can share an agent session.

## Streaming (SSE)

Set `stream: true` to receive Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Each event line is `data: <json>`
- Stream ends with `data: [DONE]`

## Examples

Non-streaming:

```bash
curl -sS http://127.0.0.1:19001/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-bitterbot-agent-id: main' \
  -d '{
    "model": "bitterbot",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:19001/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-bitterbot-agent-id: main' \
  -d '{
    "model": "bitterbot",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
