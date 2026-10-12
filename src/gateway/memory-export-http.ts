/**
 * PLAN-55 Phase 3: the memory export download.
 *
 * A full export can be tens of megabytes, more than a WebSocket frame should
 * carry (and the gateway caps incoming frames at 8 MiB). So the admin-scoped
 * `memory.exportDownload` RPC mints a one-time token, and the client fetches
 * `GET /api/memory/export/<token>`: the export is written straight to the
 * HTTP response, page by page, waiting for the socket to drain, never held
 * as one string.
 *
 * The token is the credential: 32 random bytes, single use, valid for five
 * minutes, minted only for an operator with admin scope, kept only in this
 * process's memory. A used, unknown or expired token gets a 404. The path is
 * served at the root and under the Control UI's `basePath`, and the RPC
 * hands out the link under the configured base path.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ExportSink, MemoryExportStats } from "../memory/memory-export.js";

const log = createSubsystemLogger("gateway/memory-export");

export const MEMORY_EXPORT_HTTP_PREFIX = "/api/memory/export/";
export const MEMORY_EXPORT_TOKEN_TTL_MS = 5 * 60_000;
const MAX_PENDING = 32;

type PendingExport = { agentId: string; expiresAt: number };
const pending = new Map<string, PendingExport>();

function prune(now: number): void {
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(token);
    }
  }
  // Oldest first (insertion order) when someone mints in a loop.
  while (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

/** Strip the Control UI base path (normalised, "" for none) from a request path. */
function exportPathname(pathname: string, basePath: string): string {
  return basePath && pathname.startsWith(`${basePath}${MEMORY_EXPORT_HTTP_PREFIX}`)
    ? pathname.slice(basePath.length)
    : pathname;
}

/**
 * Wait for the response to drain. Every listener it adds is removed again
 * whichever event wins, so a long download does not pile up listeners.
 */
function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (err?: Error) => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const onDrain = () => settle();
    const onClose = () => settle(new Error("the client went away"));
    const onError = (err: Error) => settle(err);
    res.on("drain", onDrain);
    res.on("close", onClose);
    res.on("error", onError);
  });
}

/** Mint a one-time download token for this agent's export. */
export function mintMemoryExportToken(
  agentId: string,
  now: number = Date.now(),
): { token: string; path: string; expiresAt: number } {
  prune(now);
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = now + MEMORY_EXPORT_TOKEN_TTL_MS;
  pending.set(token, { agentId, expiresAt });
  return { token, path: `${MEMORY_EXPORT_HTTP_PREFIX}${token}`, expiresAt };
}

/** Take a token out of the table; null when unknown, used or expired. */
export function consumeMemoryExportToken(
  token: string,
  now: number = Date.now(),
): PendingExport | null {
  const entry = pending.get(token);
  if (!entry) {
    return null;
  }
  pending.delete(token);
  return entry.expiresAt > now ? entry : null;
}

/** Test hook. */
export function resetMemoryExportTokensForTest(): void {
  pending.clear();
}

type ExportSource = {
  ownerExportTo: (sink: ExportSink) => Promise<MemoryExportStats>;
};

async function defaultOpenExportSource(agentId: string): Promise<ExportSource> {
  const { getMemorySearchManager } = await import("../memory/index.js");
  const cfg = loadConfig();
  const { manager, error } = await getMemorySearchManager({
    cfg,
    agentId: agentId || resolveDefaultAgentId(cfg),
  });
  if (!manager) {
    throw new Error(error ?? "memory is not available");
  }
  return manager as unknown as ExportSource;
}

/**
 * Serve `GET /api/memory/export/<token>`. Returns false for any other path.
 */
export async function handleMemoryExportHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    openExportSource?: (agentId: string) => Promise<ExportSource>;
    now?: () => number;
    /** `gateway.controlUi.basePath`, normalised ("" when mounted at /). */
    basePath?: string;
  } = {},
): Promise<boolean> {
  const pathname = exportPathname(
    new URL(req.url ?? "/", "http://localhost").pathname,
    deps.basePath ?? "",
  );
  if (!pathname.startsWith(MEMORY_EXPORT_HTTP_PREFIX)) {
    return false;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("Method Not Allowed");
    return true;
  }
  const token = pathname.slice(MEMORY_EXPORT_HTTP_PREFIX.length);
  const entry = token ? consumeMemoryExportToken(token, deps.now?.() ?? Date.now()) : null;
  if (!entry) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("This download link was used or has expired. Ask for a new export.");
    return true;
  }
  let source: ExportSource;
  try {
    source = await (deps.openExportSource ?? defaultOpenExportSource)(entry.agentId);
  } catch (err) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`Memory is not available: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeAgent = entry.agentId.replace(/[^A-Za-z0-9_-]/g, "_") || "agent";
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="bitterbot-memory-${safeAgent}-${stamp}.json"`,
  );
  // A socket error must not surface as an unhandled 'error' event; the
  // sink's next write sees the destroyed response and stops the export.
  const onResError = (err: Error) => log.warn(`memory export download: ${String(err)}`);
  res.on("error", onResError);
  const sink: ExportSink = async (piece) => {
    if (res.destroyed || res.writableEnded) {
      throw new Error("the client went away");
    }
    if (!res.write(piece)) {
      await waitForDrain(res);
    }
  };
  try {
    const stats = await source.ownerExportTo(sink);
    res.end();
    log.info(
      `memory export downloaded (${entry.agentId}): ${stats.memories} memories, ${stats.facts} facts, ${stats.bytes} bytes, ${stats.redactions} redaction(s)`,
    );
  } catch (err) {
    log.warn(`memory export download failed: ${String(err)}`);
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  } finally {
    res.off("error", onResError);
  }
  return true;
}
