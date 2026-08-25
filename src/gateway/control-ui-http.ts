import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveFileWithinRoot } from "../canvas-host/file-resolver.js";
import { mimeFromExtension } from "../media/mime.js";
import { cacheControlFor, resolveControlUiRoot } from "./control-ui-assets.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";

/**
 * PLAN-39 Phase 2: serve the built Control UI from the gateway.
 *
 * Mounted last in the gateway's HTTP chain, immediately before the terminal 404,
 * so every existing route (/dreams, /management, /m, /wallet/fund, /a2a, /v1/*,
 * hooks, Slack, canvas, avatars and runtime plugin routes) still wins. There is
 * deliberately no SPA history fallback: the renderer has no client-side router,
 * so an unknown path is a genuine 404 rather than a silent index.html.
 */

export type ControlUiHttpOptions = {
  /** `gateway.controlUi.enabled`. Serving is on unless explicitly disabled. */
  enabled?: boolean;
  /** `gateway.controlUi.root`. */
  configuredRoot?: string;
  /** `gateway.controlUi.basePath`, normalised ("" means mounted at /). */
  basePath?: string;
  /** Auth gate. Static assets get the same trust as the existing HTML pages. */
  isAuthorized: (req: IncomingMessage) => boolean;
};

/** Strip the configured base path, or null when the URL is outside the mount. */
export function stripBasePath(urlPath: string, basePath: string): string | null {
  if (!basePath) {
    return urlPath;
  }
  if (urlPath === basePath) {
    return "/";
  }
  if (urlPath.startsWith(`${basePath}/`)) {
    return urlPath.slice(basePath.length) || "/";
  }
  return null;
}

const weakEtag = (buf: Buffer): string => `W/"${createHash("sha1").update(buf).digest("base64")}"`;

/**
 * Returns true when the request was handled (and the response ended).
 * Returns false to let the caller fall through to its own 404.
 */
export async function handleControlUiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ControlUiHttpOptions,
): Promise<boolean> {
  if (opts.enabled === false) {
    return false;
  }
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  const rawUrl = req.url;
  if (!rawUrl) {
    return false;
  }
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return false;
  }

  const basePath = normalizeControlUiBasePath(opts.basePath);
  const relative = stripBasePath(pathname, basePath);
  if (relative === null) {
    return false;
  }

  const root = await resolveControlUiRoot({ configuredRoot: opts.configuredRoot });
  if (!root) {
    // Nothing staged. Fall through so the gateway's own 404 answers, rather than
    // claiming this route and reporting a confusing error.
    return false;
  }

  // Only gate once we know we would actually serve something, so an unauthorised
  // caller cannot use the response code to probe whether a UI is installed.
  if (!opts.isAuthorized(req)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Unauthorized");
    return true;
  }

  const opened = await resolveFileWithinRoot(root, relative).catch(() => null);
  if (!opened) {
    return false;
  }

  const { handle, realPath } = opened;
  let data: Buffer;
  try {
    data = await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }

  const relForPolicy = path.relative(root, realPath).split(path.sep).join("/");
  const cacheControl = cacheControlFor(relForPolicy);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Content-Type", mimeFromExtension(realPath) ?? "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Revalidation only matters for the mutable entries; hashed assets are immutable.
  if (cacheControl === "no-cache") {
    const etag = weakEtag(data);
    res.setHeader("ETag", etag);
    const inm = req.headers["if-none-match"];
    if (inm && inm === etag) {
      res.statusCode = 304;
      res.end();
      return true;
    }
  }

  res.statusCode = 200;
  res.setHeader("Content-Length", String(data.byteLength));
  if (method === "HEAD") {
    res.end();
    return true;
  }
  res.end(data);
  return true;
}
