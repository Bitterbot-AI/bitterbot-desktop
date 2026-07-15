/**
 * Runnable entry for the standalone Circles mailbox host (PLAN-36 Phase 1).
 *
 *   pnpm mailbox:host
 *
 * Env:
 *   MAILBOX_PORT   (default 8790)   TCP port to listen on
 *   MAILBOX_HOST   (default 0.0.0.0) bind address (public, behind a TLS proxy)
 *   MAILBOX_DB     (default ./mailbox.sqlite) SQLite file for sealed blobs
 *
 * Deploy behind a TLS reverse proxy (Caddy/nginx/Cloudflare) and point
 * `circles.mailbox.url` at the public HTTPS URL. See docs/network/mailbox-host.md.
 */

import { startMailboxHost } from "../src/gateway/a2a/mailbox-host.js";

const port = Number(process.env.MAILBOX_PORT ?? 8790);
const host = process.env.MAILBOX_HOST ?? "0.0.0.0";
const dbPath = process.env.MAILBOX_DB ?? "./mailbox.sqlite";

const handle = await startMailboxHost({ port, host, dbPath });
// eslint-disable-next-line no-console
console.log(`circles mailbox host listening on ${host}:${handle.port} (db=${dbPath})`);

const shutdown = () => {
  void handle.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
