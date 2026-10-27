---
summary: "Gateway singleton guard using the WebSocket listener bind"
read_when:
  - Running or debugging the gateway process
  - Investigating single-instance enforcement
title: "Gateway Lock"
---

# Gateway lock

Last updated: 2026-10-27

## Why

- Ensure only one gateway instance runs per base port on the same host; additional gateways must use isolated profiles and unique ports.
- Survive crashes/SIGKILL without leaving stale lock files.
- Fail fast with a clear error when the control port is already occupied.

## Mechanism

- The gateway binds the WebSocket listener (default `ws://127.0.0.1:19001`) immediately on startup using an exclusive TCP listener.
- If the bind fails with `EADDRINUSE`, startup throws `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- The OS releases the listener automatically on any process exit, including crashes and SIGKILL—no separate lock file or cleanup step is needed.
- On shutdown the gateway closes the WebSocket server and underlying HTTP server to free the port promptly.

## Error surface

- If another process holds the port, startup throws `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Other bind failures surface as `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## Restart handoff

- A full-process restart (SIGUSR1, the gateway tool, a config change that needs a restart) spawns the new gateway while the old one is still draining tasks and closing the server; the orchestrator sidecar alone can take ten seconds to exit. The child therefore usually finds the lock file still held by its parent.
- The child is told who its parent is (`BITTERBOT_RESTART_PARENT_PID`). When the lock owner is that pid, the child waits up to 120 s for the parent to release the lock or exit instead of giving up at the plain 5 s timeout, and logs `lock still held by the restarting gateway (pid …); waiting for it to exit` once.
- The parent releases the lock right after the spawn succeeds, before it exits, so the handoff normally completes in well under a second.
- Before 2026-10-27 the child gave up at 5 s, the parent then exited, and no gateway was left listening (a 51-minute outage on the reference node). A lock held by any other live gateway still fails fast as before.

## Operational notes

- If the port is occupied by _another_ process, the error is the same; free the port or choose another with `bitterbot gateway --port <port>`.
- The runtime lock is enforced by the WebSocket bind.
