---
summary: "Connect MCP servers so the agent can use other services, with changes held for your approval"
read_when:
  - You want the agent to use a calendar, mailbox, tracker or another service
  - Adding an MCP server
title: "Connectors"
---

# Connectors

A connector is an [MCP](https://modelcontextprotocol.io) server the agent can use: a remote server you reach by its address, or a program that runs on this machine. Each server's tools reach the agent as `mcp__<connector>__<tool>`, under the same tool policy, deferred loading and review as built-in tools.

## Adding one

Open **Connectors** in the Control UI and add:

- **A remote server:** its address (`https://…/mcp`), and an API key if it needs one (sent as `Authorization: Bearer …`).
- **A program on this machine:** the command that starts it, for example `npx -y <some-mcp-server>`.

Or over the gateway:

```bash
bitterbot gateway call mcp.add --params '{"name":"calendar","transport":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer ..."}}'
bitterbot gateway call mcp.list
```

Connectors are kept in `~/.bitterbot/mcp/servers.json` (mode 0600, since headers and environment can hold keys). The page shows whether each one is connected, its tools, and which of them change things.

## Reads and changes

A tool the server declares read-only (`readOnlyHint`) runs straight away. Any other tool is treated as one that changes something: the call waits in the approval queue with the connector, the tool and its arguments, and runs once you approve it. A server that does not say counts as one that changes things.

To let one connector change things without asking, tick **Let this connector change things without asking** on its card (`trustWrites`). To turn the review off for all connectors, set `review.connector: "allow"`.

## Safety

- Connector tools are owner-only: someone else writing to your agent in a group cannot use your connectors.
- They cannot be invoked over the gateway's HTTP `POST /tools/invoke` endpoint, which skips review, unless you allow a tool by name in `gateway.tools.allow`.
- A remote server must use `https` (plain `http` only for this machine).
- A local program runs with your user's permissions, like any program you start.

## Limits

- No sign-in flow yet: a server that needs OAuth cannot be connected. Servers that take an API key in a header work.
- No built-in catalogue of servers; you add each one by address or command.
- The agent sees text results; images and other content are described, not shown.
