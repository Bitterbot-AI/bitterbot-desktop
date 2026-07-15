/**
 * PLAN-36 Phase 1: a standalone, deployable mailbox host.
 *
 * Circles' store-and-forward mailbox lets a NAT'd / offline peer receive
 * messages on wake — but the mailbox verbs are only served by a full gateway
 * (circles.mailbox.serve), which is a ~20-min-boot process with in-process
 * memory engines. The relay fleet runs only the Rust orchestrator, so NO host
 * serves mailboxes out of the box, and there is no default circles.mailbox.url.
 * That is the single biggest reason offline delivery silently fails today.
 *
 * This module is the missing piece: a slim HTTP process that serves ONLY
 * mailbox/post|poll|ack, reusing the tested, sealed, quota'd handler
 * (src/gateway/a2a/mailbox.ts) over its own SQLite file. It holds ciphertext it
 * cannot read (X25519 sealed boxes), so it is a metadata-only relay — the
 * PLAN-31 §3.2 "a mailbox is a server, but not one that can read your messages"
 * honesty claim, made deployable. Boots in milliseconds; run one per fleet (or
 * a few behind a load balancer) and point circles.mailbox.url at it.
 *
 * TLS is expected to be terminated by a reverse proxy (Caddy/nginx/Cloudflare)
 * in front of this, the same way the gateway's public a2a endpoint is fronted.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { handleMailboxMethod, sweepExpiredMailboxBlobs } from "./mailbox.js";

const log = createSubsystemLogger("a2a/mailbox-host");

/** Requests larger than this are rejected before JSON parsing. */
const MAX_REQUEST_BYTES = 128 * 1024;
/** How often to prune expired blobs. */
const SWEEP_INTERVAL_MS = 60 * 60_000;

export type MailboxHostHandle = {
  readonly port: number;
  close: () => Promise<void>;
};

/** Ensure the single table this host needs (no full memory schema required). */
export function ensureMailboxSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox_blobs (
      blob_id          TEXT PRIMARY KEY,
      recipient_pubkey TEXT NOT NULL,
      sender_pubkey    TEXT NOT NULL,
      blob_json        TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mailbox_blobs_recipient ` +
      `ON mailbox_blobs(recipient_pubkey, created_at)`,
  );
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        resolve(null); // too large
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/**
 * Start a mailbox host. Serves POST <path> (default /a2a, matching the client
 * which posts to `<mailboxUrl>/a2a`) for mailbox/* verbs only, plus GET / as a
 * health check. Returns a handle; call close() to stop.
 */
export function startMailboxHost(opts: {
  port: number;
  /** Bind host. Default 0.0.0.0 (this is meant to be public behind a proxy). */
  host?: string;
  /** SQLite file path. Default ":memory:" (tests); pass a real path in prod. */
  dbPath?: string;
  /** RPC path clients post to. Default "/a2a". */
  path?: string;
}): Promise<MailboxHostHandle> {
  const path = opts.path ?? "/a2a";
  const db = new DatabaseSync(opts.dbPath ?? ":memory:");
  ensureMailboxSchema(db);

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Health check for load balancers / uptime probes.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      sendJson(res, 200, { ok: true, service: "circles-mailbox" });
      return;
    }
    if (req.method !== "POST" || url.pathname !== path) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "request too large or unreadable" });
      return;
    }
    let rpc: { id?: unknown; method?: unknown; params?: unknown };
    try {
      rpc = JSON.parse(raw);
    } catch {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "parse error" },
        id: null,
      });
      return;
    }
    const method = typeof rpc.method === "string" ? rpc.method : "";
    const id = rpc.id ?? null;
    // A dedicated mailbox host serves ONLY mailbox verbs — nothing else.
    if (!method.startsWith("mailbox/")) {
      sendJson(res, 404, {
        jsonrpc: "2.0",
        error: { code: -32601, message: "method not found (mailbox host serves mailbox/* only)" },
        id,
      });
      return;
    }
    const outcome = handleMailboxMethod(method, rpc.params, db, Date.now());
    sendJson(
      res,
      200,
      outcome.ok
        ? { jsonrpc: "2.0", result: outcome.result, id }
        : { jsonrpc: "2.0", error: outcome.error, id },
    );
  }

  // Periodic TTL sweep so ciphertext for peers who never return does not
  // accumulate forever (blobs also carry a 30-day expiry).
  const sweep = setInterval(() => {
    try {
      const removed = sweepExpiredMailboxBlobs(db, Date.now());
      if (removed > 0) log.debug(`swept ${removed} expired mailbox blob(s)`);
    } catch (err) {
      log.debug(`mailbox sweep failed: ${String(err)}`);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();

  return new Promise<MailboxHostHandle>((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      log.info(
        `mailbox host listening on ${opts.host ?? "0.0.0.0"}:${port} (db=${opts.dbPath ?? ":memory:"})`,
      );
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(sweep);
            server.close(() => {
              db.close();
              res();
            });
          }),
      });
    });
  });
}
