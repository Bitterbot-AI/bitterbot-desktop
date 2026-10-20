/**
 * HTTPS_PROXY / NO_PROXY for release downloads, against a local CONNECT
 * proxy (no network): the rules, a TLS GET through the tunnel to a local
 * self-signed server, proxy credentials, a refused tunnel, and the wiring
 * into the release fetcher the launcher and the updater share.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noProxyMatches, proxiedGet, proxyForUrl } from "./http-proxy.js";
import { fetchReleaseText, resolveReleaseSource } from "./tarball-release.js";

describe("proxyForUrl", () => {
  it("uses HTTPS_PROXY for https, falling back to HTTP_PROXY, either case", () => {
    expect(proxyForUrl("https://github.com/x", { HTTPS_PROXY: "http://p:3128" })?.host).toBe(
      "p:3128",
    );
    expect(proxyForUrl("https://github.com/x", { https_proxy: "p2:8080" })?.href).toBe(
      "http://p2:8080/",
    );
    expect(proxyForUrl("https://github.com/x", { HTTP_PROXY: "http://p3:1" })?.host).toBe("p3:1");
    expect(proxyForUrl("http://example.com/x", { HTTPS_PROXY: "http://p:1" })).toBeNull();
    expect(proxyForUrl("http://example.com/x", { http_proxy: "http://p:1" })?.host).toBe("p:1");
    expect(proxyForUrl("https://github.com/x", {})).toBeNull();
  });

  it("never proxies loopback and honours NO_PROXY", () => {
    const env = { HTTPS_PROXY: "http://p:3128", HTTP_PROXY: "http://p:3128" };
    expect(proxyForUrl("http://127.0.0.1:8765/x", env)).toBeNull();
    expect(proxyForUrl("https://localhost/x", env)).toBeNull();
    expect(proxyForUrl("https://github.com/x", { ...env, NO_PROXY: "github.com" })).toBeNull();
    expect(
      proxyForUrl("https://objects.githubusercontent.com/x", { ...env, no_proxy: "*" }),
    ).toBeNull();
    expect(proxyForUrl("https://github.com/x", { ...env, NO_PROXY: "gitlab.com" })).not.toBeNull();
  });

  it("matches NO_PROXY entries exactly or as domain suffixes", () => {
    expect(noProxyMatches("dl.example.com", "example.com")).toBe(true);
    expect(noProxyMatches("dl.example.com", ".example.com")).toBe(true);
    expect(noProxyMatches("dl.example.com", "*.example.com")).toBe(true);
    expect(noProxyMatches("example.com", "example.com:443")).toBe(true);
    expect(noProxyMatches("badexample.com", "example.com")).toBe(false);
    expect(noProxyMatches("github.com", "internal.lan, github.com")).toBe(true);
    expect(noProxyMatches("github.com", "")).toBe(false);
    expect(noProxyMatches("github.com", null)).toBe(false);
  });
});

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe.skipIf(!hasOpenssl)("through a local CONNECT proxy", () => {
  let dir: string;
  let ca: Buffer;
  let target: https.Server;
  let targetPort: number;
  let proxy: http.Server;
  let proxyPort: number;
  const connects: Array<{ authority: string; auth: string | undefined }> = [];
  let refuse = false;
  const sockets = new Set<net.Socket>();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-proxy-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=releases.bitterbot.test",
        "-addext",
        "subjectAltName=DNS:releases.bitterbot.test",
      ],
      { stdio: "ignore" },
    );
    ca = fs.readFileSync(path.join(dir, "cert.pem"));
    target = https.createServer(
      { key: fs.readFileSync(path.join(dir, "key.pem")), cert: ca },
      (req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`hello ${req.url}`);
      },
    );
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    targetPort = (target.address() as AddressInfo).port;
    proxy = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    proxy.on("connect", (req, socket: net.Socket, head: Buffer) => {
      connects.push({ authority: req.url ?? "", auth: req.headers["proxy-authorization"] });
      sockets.add(socket);
      if (refuse) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        return;
      }
      // Every host resolves to the local TLS server.
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        sockets.add(upstream);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of sockets) {
      s.destroy();
    }
    proxy.closeAllConnections();
    target.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => target.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function body(res: http.IncomingMessage): Promise<string> {
    let out = "";
    for await (const chunk of res) {
      out += String(chunk);
    }
    return out;
  }

  it("tunnels an https GET with end-to-end TLS and proxy credentials", async () => {
    connects.length = 0;
    refuse = false;
    const res = await proxiedGet("https://releases.bitterbot.test/v1/checksums.txt", {
      headers: {},
      timeoutMs: 10_000,
      env: { HTTPS_PROXY: `http://bb:s%40cret@127.0.0.1:${proxyPort}` },
      tlsOptions: { ca },
      onTimeout: (req) => req.destroy(new Error("timeout")),
    });
    expect(res.statusCode).toBe(200);
    expect(await body(res)).toBe("hello /v1/checksums.txt");
    expect(connects).toEqual([
      {
        authority: "releases.bitterbot.test:443",
        auth: `Basic ${Buffer.from("bb:s@cret").toString("base64")}`,
      },
    ]);
  });

  it("verifies the target's certificate through the tunnel", async () => {
    refuse = false;
    await expect(
      proxiedGet("https://releases.bitterbot.test/x", {
        headers: {},
        timeoutMs: 10_000,
        env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
        onTimeout: (req) => req.destroy(new Error("timeout")),
      }),
    ).rejects.toThrow(/self[- ]signed|certificate/i);
  });

  it("a refused tunnel is an error naming the proxy", async () => {
    refuse = true;
    await expect(
      proxiedGet("https://releases.bitterbot.test/x", {
        headers: {},
        timeoutMs: 10_000,
        env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
        tlsOptions: { ca },
        onTimeout: (req) => req.destroy(new Error("timeout")),
      }),
    ).rejects.toThrow(/refused the tunnel \(HTTP 407\)/);
    refuse = false;
  });

  it("the release fetcher (launcher and updater) goes through HTTPS_PROXY", async () => {
    connects.length = 0;
    refuse = true;
    const source = resolveReleaseSource({
      allowTestMode: false,
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
    });
    await expect(
      fetchReleaseText(source, `${source.baseUrl}/download/v1.6.2/checksums.txt`, 10_000),
    ).rejects.toThrow(/refused the tunnel/);
    expect(connects.map((c) => c.authority)).toEqual(["github.com:443"]);
    refuse = false;
  });
});
