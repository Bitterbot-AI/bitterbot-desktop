/**
 * Shared secret for the orchestrator control channel (security pass HIGH-5).
 *
 * On Windows the orchestrator listens on loopback TCP 19002, which any local
 * process can reach; the 0600 chmod that guards the Unix socket has no TCP
 * equivalent. The gateway hands the daemon this token in BITTERBOT_IPC_TOKEN
 * at spawn and sends it as the first line of every IPC connection; the daemon
 * closes connections that do not.
 *
 * Persisted (0600, next to the node key) rather than per-boot so a gateway
 * restart can still talk to an orchestrator that outlived the previous one.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const IPC_TOKEN_FILENAME = "ipc.token";

/** Read the token in `dir`, creating a fresh 256-bit one when absent or unusable. */
export function loadOrCreateIpcToken(dir: string): string {
  const file = path.join(dir, IPC_TOKEN_FILENAME);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      return existing;
    }
  } catch {
    // absent: create below
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort (Windows ignores POSIX modes; the per-user profile ACL applies)
  }
  return token;
}

/** The first line a client sends on a fresh IPC connection. */
export function ipcAuthLine(token: string): string {
  return `${JSON.stringify({ type: "auth", id: crypto.randomUUID(), payload: { token } })}\n`;
}
