/**
 * HTTP(S)_PROXY support for release downloads (the npm launcher and the
 * in-place tarball updater), with node:http, node:https and node:tls only:
 * the launcher bundle must not pull in a proxy-agent dependency.
 *
 *   https:// targets  HTTPS_PROXY / https_proxy, else HTTP_PROXY / http_proxy,
 *                     through an HTTP CONNECT tunnel; TLS (and certificate
 *                     verification) is end to end with the target host.
 *   http:// targets   HTTP_PROXY / http_proxy, as an absolute-URI request.
 *   NO_PROXY / no_proxy: comma or space separated host names, matched
 *                     exactly or as a domain suffix (`example.com` and
 *                     `.example.com` both cover `dl.example.com`); `*`
 *                     disables the proxy. Loopback targets never use one.
 *
 * Credentials in the proxy URL (http://user:pass@proxy:3128) are sent as
 * Proxy-Authorization: Basic. The proxy itself may be http:// or https://.
 */

import http from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import tls from "node:tls";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | null {
  for (const name of names) {
    const v = env[name]?.trim();
    if (v) {
      return v;
    }
  }
  return null;
}

/** True when NO_PROXY exempts `hostname`. */
export function noProxyMatches(hostname: string, noProxy: string | null): boolean {
  if (!noProxy) {
    return false;
  }
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  for (const raw of noProxy.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) {
      continue;
    }
    if (entry === "*") {
      return true;
    }
    // Drop a port (host:port) but keep IPv6 literals intact.
    if (!entry.startsWith("[") && (entry.match(/:/g) ?? []).length === 1) {
      entry = entry.slice(0, entry.indexOf(":"));
    }
    entry = entry.replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
    if (host === entry || host.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}

/** The proxy for `url`, or null for a direct connection. */
export function proxyForUrl(url: string, env: NodeJS.ProcessEnv = process.env): URL | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return null;
  }
  if (LOOPBACK_HOSTS.has(target.hostname.toLowerCase())) {
    return null;
  }
  if (noProxyMatches(target.hostname, envValue(env, "NO_PROXY", "no_proxy"))) {
    return null;
  }
  const raw =
    target.protocol === "https:"
      ? envValue(env, "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")
      : envValue(env, "HTTP_PROXY", "http_proxy");
  if (!raw) {
    return null;
  }
  try {
    const proxy = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return proxy.protocol === "http:" || proxy.protocol === "https:" ? proxy : null;
  } catch {
    return null;
  }
}

function proxyAuthHeader(proxy: URL): Record<string, string> {
  if (!proxy.username) {
    return {};
  }
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password);
  return {
    "Proxy-Authorization": `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
  };
}

function proxyPort(proxy: URL): number {
  return Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
}

/** An HTTP CONNECT tunnel through `proxy` to host:port (raw TCP, not yet TLS). */
export function openProxyTunnel(
  proxy: URL,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  const request = proxy.protocol === "https:" ? https.request : http.request;
  const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  return new Promise((resolve, reject) => {
    const req = request({
      host: proxy.hostname,
      port: proxyPort(proxy),
      method: "CONNECT",
      path: authority,
      headers: { Host: authority, ...proxyAuthHeader(proxy) },
      agent: false,
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`the proxy ${proxy.host} did not answer CONNECT in time`));
    });
    req.once("connect", (res: http.IncomingMessage, socket: Socket) => {
      req.setTimeout(0);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(
          Object.assign(
            new Error(`the proxy ${proxy.host} refused the tunnel (HTTP ${res.statusCode})`),
            { code: "EPROXY" },
          ),
        );
        return;
      }
      resolve(socket);
    });
    req.once("error", reject);
    req.end();
  });
}

/**
 * One GET of `url`, through the environment's proxy when one applies. The
 * response is returned unread; `timeoutMs` is a socket idle timeout.
 * `tlsOptions` exists for tests (a self-signed target).
 */
export async function proxiedGet(
  url: string,
  opts: {
    headers: Record<string, string>;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    tlsOptions?: tls.ConnectionOptions;
    onTimeout: (req: http.ClientRequest) => void;
  },
): Promise<http.IncomingMessage> {
  const proxy = proxyForUrl(url, opts.env ?? process.env);
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const send = (make: (cb: (res: http.IncomingMessage) => void) => http.ClientRequest) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = make(resolve);
      req.on("error", reject);
      req.setTimeout(opts.timeoutMs, () => opts.onTimeout(req));
    });

  if (!proxy) {
    const get = isHttps ? https.get : http.get;
    return send((cb) => get(url, { headers: opts.headers, ...opts.tlsOptions }, cb));
  }
  if (!isHttps) {
    // Plain http through a forward proxy: the absolute URI goes to the proxy.
    const request = proxy.protocol === "https:" ? https.request : http.request;
    return send((cb) => {
      const req = request(
        {
          host: proxy.hostname,
          port: proxyPort(proxy),
          method: "GET",
          path: url,
          headers: { ...opts.headers, Host: target.host, ...proxyAuthHeader(proxy) },
          agent: false,
        },
        cb,
      );
      req.end();
      return req;
    });
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port) || 443;
  const tunnel = await openProxyTunnel(proxy, host, port, opts.timeoutMs);
  return send((cb) =>
    https.get(
      url,
      {
        headers: opts.headers,
        // No agent: with createConnection and agent left undefined, Node
        // uses this socket (agent:false would make a fresh Agent that
        // ignores createConnection and dials the target directly).
        createConnection: () =>
          tls.connect({
            ...opts.tlsOptions,
            socket: tunnel,
            ...(isIP(host) ? {} : { servername: host }),
          }),
      },
      cb,
    ),
  );
}
