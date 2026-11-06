---
summary: "CLI reference for `bitterbot devices` (device pairing + token rotation/revocation)"
read_when:
  - You are approving device pairing requests
  - You need to rotate or revoke device tokens
title: "devices"
---

# `bitterbot devices`

Manage device pairing requests and device-scoped tokens.

## Commands

### `bitterbot devices list`

List pending pairing requests and paired devices.

```
bitterbot devices list
bitterbot devices list --json
```

### `bitterbot devices pair`

Pair a phone: prints a one-time QR code and link (five minutes, single use) for the
[phone app](/web/mobile). The phone then shows a six-digit code; approve it with
`bitterbot devices approve <code>` once it matches.

```
bitterbot devices pair
```

The link never contains the gateway token. If the gateway only listens on loopback, the
command explains how to make it reachable (Tailscale Serve, `gateway.bind: "lan"`, or
`gateway.mobile.publicUrl`).

### `bitterbot devices approve <requestId|code>`

Approve a pending device pairing request, by request id or by the six-digit code a phone shows.

```
bitterbot devices approve <requestId>
bitterbot devices approve 472913
```

### `bitterbot devices reject <requestId|code>`

Reject a pending device pairing request.

```
bitterbot devices reject <requestId>
```

### `bitterbot devices rename <deviceId> <name>`

Give a paired device a name (shown in the Control UI and `devices list`).

```
bitterbot devices rename <deviceId> "Work phone"
```

### `bitterbot devices remove <deviceId>`

Unpair a device: delete its tokens and push subscription and close its open connections. The
gateway token and other devices are untouched.

```
bitterbot devices remove <deviceId>
```

### `bitterbot devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotate a device token for a specific role (optionally updating scopes).

```
bitterbot devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `bitterbot devices revoke --device <id> --role <role>`

Revoke a device token for a specific role. Open connections from that device are closed and its
push subscription is deleted.

```
bitterbot devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: Gateway WebSocket URL (defaults to `gateway.remote.url` when configured).
- `--token <token>`: Gateway token (if required).
- `--password <password>`: Gateway password (password auth).
- `--timeout <ms>`: RPC timeout.
- `--json`: JSON output (recommended for scripting).

Note: when you set `--url`, the CLI does not fall back to config or environment credentials.
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.

## Notes

- Token rotation returns a new token (sensitive). Treat it like a secret.
- These commands require `operator.pairing` (or `operator.admin`) scope.
