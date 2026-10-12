/**
 * Setup token for browser-first onboarding (PLAN-56 Phase 4).
 *
 * `bitterbot onboard` (or a container's first boot) mints a random token and
 * prints `http://127.0.0.1:<port>/setup?token=...`. The token:
 *
 * - grants ONLY the wizard RPCs (`wizard.start/next/cancel/status`), never the
 *   admin scope: a connection that presents it gets the `operator.setup` scope
 *   and nothing else, receives no broadcast events, and skips device pairing;
 * - expires 30 minutes after it was minted;
 * - works until setup finishes: the setup it drives deletes it on completion,
 *   and minting a new one replaces the old one (there is at most one live
 *   setup token; a wizard session started with a replaced or expired token is
 *   cancelled when the new link starts setup);
 * - is accepted from a loopback Host header only (see `setupTokenRequestAllowed`).
 *
 * Only a SHA-256 of the token is stored, in `<stateDir>/setup-token.json`
 * (mode 0600). The CLI and the gateway share the state directory, which is how
 * a token minted by `bitterbot onboard` reaches a gateway that is already
 * running (a service, a container). Whoever can write the state directory can
 * already edit the config, so the file adds no new trust.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";

/** The only scope a setup-token connection holds. */
export const SETUP_SCOPE = "operator.setup";

/** RPC methods a setup-token connection may call. */
export const SETUP_METHODS: ReadonlySet<string> = new Set([
  "wizard.start",
  "wizard.next",
  "wizard.cancel",
  "wizard.status",
]);

/** Events a setup-token connection receives (keepalive only). */
export const SETUP_EVENTS: ReadonlySet<string> = new Set(["tick"]);

export const SETUP_TOKEN_TTL_MS = 30 * 60 * 1000;
export const SETUP_TOKEN_FILE = "setup-token.json";
/**
 * Present while a browser setup has written part of the config but not
 * finished (the first reply runs between two writes). Until it is removed, a
 * setup link may still start (or restart) setup.
 */
export const SETUP_IN_PROGRESS_FILE = "setup-in-progress.json";

type StoredSetupToken = {
  sha256: string;
  issuedAt: number;
  expiresAt: number;
};

export type SetupTokenCheck =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: "missing" | "invalid" | "expired" };

function tokenPath(stateDir?: string): string {
  return path.join(stateDir ?? resolveStateDir(), SETUP_TOKEN_FILE);
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function readStored(stateDir?: string): StoredSetupToken | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(tokenPath(stateDir), "utf8"),
    ) as Partial<StoredSetupToken>;
    if (
      typeof raw.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(raw.sha256) ||
      typeof raw.expiresAt !== "number" ||
      typeof raw.issuedAt !== "number"
    ) {
      return null;
    }
    return { sha256: raw.sha256, issuedAt: raw.issuedAt, expiresAt: raw.expiresAt };
  } catch {
    return null;
  }
}

/**
 * Mint a new setup token, replacing any previous one. Returns the token itself
 * (shown once, in the setup URL); only its hash is written.
 */
export function issueSetupToken(opts?: { stateDir?: string; now?: number; ttlMs?: number }): {
  token: string;
  expiresAt: number;
} {
  const now = opts?.now ?? Date.now();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = now + (opts?.ttlMs ?? SETUP_TOKEN_TTL_MS);
  const file = tokenPath(opts?.stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const record: StoredSetupToken = { sha256: hashToken(token), issuedAt: now, expiresAt };
  fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { token, expiresAt };
}

/** Constant-time check of a presented token against the stored hash and expiry. */
export function verifySetupToken(
  token: string | undefined | null,
  opts?: { stateDir?: string; now?: number },
): SetupTokenCheck {
  const presented = typeof token === "string" ? token.trim() : "";
  if (!presented) {
    return { ok: false, reason: "missing" };
  }
  const stored = readStored(opts?.stateDir);
  if (!stored) {
    return { ok: false, reason: "invalid" };
  }
  const a = Buffer.from(hashToken(presented), "hex");
  const b = Buffer.from(stored.sha256, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid" };
  }
  const now = opts?.now ?? Date.now();
  if (now >= stored.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, expiresAt: stored.expiresAt };
}

/** True while an unexpired setup token exists (whatever its value). */
export function setupTokenLive(opts?: { stateDir?: string; now?: number }): boolean {
  const stored = readStored(opts?.stateDir);
  return Boolean(stored && (opts?.now ?? Date.now()) < stored.expiresAt);
}

/** The stored hash of the live (unexpired) setup token, or null. */
export function liveSetupTokenHash(opts?: { stateDir?: string; now?: number }): string | null {
  const stored = readStored(opts?.stateDir);
  if (!stored || (opts?.now ?? Date.now()) >= stored.expiresAt) {
    return null;
  }
  return stored.sha256;
}

function inProgressPath(stateDir?: string): string {
  return path.join(stateDir ?? resolveStateDir(), SETUP_IN_PROGRESS_FILE);
}

/** Record that setup wrote part of the config and has not finished yet. */
export function markSetupInProgress(opts?: { stateDir?: string; now?: number }): void {
  const file = inProgressPath(opts?.stateDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ startedAt: opts?.now ?? Date.now() })}\n`, {
      mode: 0o600,
    });
  } catch {
    // Best effort: without the marker an interrupted setup needs the admin sign-in.
  }
}

export function setupInProgress(opts?: { stateDir?: string }): boolean {
  return fs.existsSync(inProgressPath(opts?.stateDir));
}

export function clearSetupInProgress(opts?: { stateDir?: string }): void {
  try {
    fs.rmSync(inProgressPath(opts?.stateDir), { force: true });
  } catch {
    // Nothing to clear.
  }
}

/** The setup page URL for this gateway (`<basePath>/setup`, token in the query). */
export function buildSetupUrl(params: { port: number; basePath?: string; token?: string }): string {
  const base = normalizeControlUiBasePath(params.basePath);
  const query = params.token ? `?token=${encodeURIComponent(params.token)}` : "";
  return `http://127.0.0.1:${params.port}${base}/setup${query}`;
}

/** Delete the live setup token (wizard completed, or an explicit revoke). */
export function revokeSetupToken(opts?: { stateDir?: string }): void {
  try {
    fs.rmSync(tokenPath(opts?.stateDir), { force: true });
  } catch {
    // Nothing to revoke.
  }
}

/** True when the connection holds only the setup scope (never admin). */
export function isSetupOnlyScopes(scopes: readonly string[] | undefined): boolean {
  const list = scopes ?? [];
  return list.includes(SETUP_SCOPE) && !list.includes("operator.admin");
}

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

export function hostnameOf(hostHeader: string | undefined): string | null {
  const value = hostHeader?.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? null : value.slice(0, end + 1);
  }
  const parts = value.split(":");
  if (parts.length > 2) {
    return null;
  }
  return parts[0] || null;
}

/**
 * Where a setup token is accepted: the browser must have addressed the gateway
 * by a loopback name (the setup URL always says 127.0.0.1), which also stops a
 * DNS-rebinding page from using a token it somehow learned. The socket must be
 * loopback too, except in a container, where Docker's port mapping delivers
 * the host's loopback connection from the bridge address; there the host-side
 * port binding (127.0.0.1 by default in docker-compose.yml) is the boundary.
 * Proxy headers disqualify the request: a reverse proxy means the browser is
 * not on this machine.
 */
export function setupTokenRequestAllowed(params: {
  hostHeader: string | undefined;
  remoteIsLoopback: boolean;
  hasProxyHeaders: boolean;
  inContainer: boolean;
}): boolean {
  const host = hostnameOf(params.hostHeader);
  if (!host || !LOOPBACK_HOSTS.has(host)) {
    return false;
  }
  if (params.hasProxyHeaders) {
    return false;
  }
  return params.remoteIsLoopback || params.inContainer;
}
