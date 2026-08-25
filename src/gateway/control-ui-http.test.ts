import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cacheControlFor,
  controlUiRootCandidates,
  resetControlUiRootCache,
} from "./control-ui-assets.js";
import { handleControlUiRequest, stripBasePath } from "./control-ui-http.js";

const dirs: string[] = [];

const makeRoot = async (files: Record<string, string>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-cui-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, "utf8");
  }
  return dir;
};

type FakeRes = ServerResponse & {
  headers: Record<string, string>;
  body: string;
  ended: boolean;
};

const makeReq = (url: string, method = "GET", headers: Record<string, string> = {}) =>
  ({ url, method, headers }) as unknown as IncomingMessage;

const makeRes = (): FakeRes => {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    setHeader(k: string, v: string | number) {
      this.headers[k.toLowerCase()] = String(v);
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      }
      this.ended = true;
    },
  };
  return res as unknown as FakeRes;
};

const allow = () => true;
const deny = () => false;

afterEach(async () => {
  resetControlUiRootCache();
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      await fs.rm(d, { recursive: true, force: true });
    }
  }
});

describe("control UI static serving", () => {
  it("serves index.html at the mount root", async () => {
    const root = await makeRoot({ "index.html": "<!doctype html>hello" });
    const res = makeRes();
    const handled = await handleControlUiRequest(makeReq("/"), res, {
      configuredRoot: root,
      isAuthorized: allow,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("hello");
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("serves ES modules with a JavaScript content type", async () => {
    // Without this browsers refuse to execute the module: the shared MIME table
    // had no .js entry and static files fell back to application/octet-stream.
    const root = await makeRoot({
      "index.html": "x",
      "assets/app-abc123.js": "export default 1;",
    });
    const res = makeRes();
    await handleControlUiRequest(makeReq("/assets/app-abc123.js"), res, {
      configuredRoot: root,
      isAuthorized: allow,
    });
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("marks hashed assets immutable and index.html revalidating", async () => {
    const root = await makeRoot({ "index.html": "x", "assets/a-1.css": "body{}" });
    const asset = makeRes();
    await handleControlUiRequest(makeReq("/assets/a-1.css"), asset, {
      configuredRoot: root,
      isAuthorized: allow,
    });
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const html = makeRes();
    await handleControlUiRequest(makeReq("/"), html, {
      configuredRoot: root,
      isAuthorized: allow,
    });
    expect(html.headers["cache-control"]).toBe("no-cache");
    expect(html.headers.etag).toBeTruthy();
  });

  it("answers 304 when the ETag matches", async () => {
    const root = await makeRoot({ "index.html": "same" });
    const first = makeRes();
    await handleControlUiRequest(makeReq("/"), first, {
      configuredRoot: root,
      isAuthorized: allow,
    });
    const etag = first.headers.etag;
    const second = makeRes();
    await handleControlUiRequest(makeReq("/", "GET", { "if-none-match": etag }), second, {
      configuredRoot: root,
      isAuthorized: allow,
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });

  it("HEAD returns headers with no body", async () => {
    const root = await makeRoot({ "index.html": "hello" });
    const res = makeRes();
    await handleControlUiRequest(makeReq("/", "HEAD"), res, {
      configuredRoot: root,
      isAuthorized: allow,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    expect(res.headers["content-length"]).toBe("5");
  });

  it("refuses path traversal", async () => {
    const root = await makeRoot({ "index.html": "x" });
    const secret = path.join(path.dirname(root), "outside-secret.txt");
    await fs.writeFile(secret, "TOPSECRET", "utf8");
    try {
      for (const attempt of [
        "/../outside-secret.txt",
        "/..%2Foutside-secret.txt",
        "/assets/../../outside-secret.txt",
      ]) {
        const res = makeRes();
        const handled = await handleControlUiRequest(makeReq(attempt), res, {
          configuredRoot: root,
          isAuthorized: allow,
        });
        expect(res.body, attempt).not.toContain("TOPSECRET");
        expect(handled, attempt).toBe(false);
      }
    } finally {
      await fs.rm(secret, { force: true });
    }
  });

  it("does not fall back to index.html for unknown paths (no SPA history fallback)", async () => {
    // The renderer has no client-side router, so an unknown path is a real 404.
    const root = await makeRoot({ "index.html": "shell" });
    const res = makeRes();
    const handled = await handleControlUiRequest(makeReq("/does/not/exist"), res, {
      configuredRoot: root,
      isAuthorized: allow,
    });
    expect(handled).toBe(false);
    expect(res.body).not.toContain("shell");
  });

  it("falls through when disabled, restoring the previous 404", async () => {
    const root = await makeRoot({ "index.html": "x" });
    const res = makeRes();
    const handled = await handleControlUiRequest(makeReq("/"), res, {
      enabled: false,
      configuredRoot: root,
      isAuthorized: allow,
    });
    expect(handled).toBe(false);
    expect(res.ended).toBe(false);
  });

  it("falls through when nothing is staged", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "bb-cui-empty-"));
    dirs.push(empty);
    const res = makeRes();
    const handled = await handleControlUiRequest(makeReq("/"), res, {
      configuredRoot: empty,
      isAuthorized: allow,
    });
    expect(handled).toBe(false);
  });

  it("ignores non-GET/HEAD methods so other routes keep them", async () => {
    const root = await makeRoot({ "index.html": "x" });
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const res = makeRes();
      const handled = await handleControlUiRequest(makeReq("/", method), res, {
        configuredRoot: root,
        isAuthorized: allow,
      });
      expect(handled, method).toBe(false);
    }
  });

  it("rejects unauthorised callers with 401", async () => {
    const root = await makeRoot({ "index.html": "x" });
    const res = makeRes();
    const handled = await handleControlUiRequest(makeReq("/"), res, {
      configuredRoot: root,
      isAuthorized: deny,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("x");
  });

  it("serves under a non-root basePath and ignores paths outside it", async () => {
    const root = await makeRoot({ "index.html": "mounted" });
    const inside = makeRes();
    expect(
      await handleControlUiRequest(makeReq("/ui/"), inside, {
        configuredRoot: root,
        basePath: "/ui",
        isAuthorized: allow,
      }),
    ).toBe(true);
    expect(inside.body).toContain("mounted");

    const outside = makeRes();
    expect(
      await handleControlUiRequest(makeReq("/elsewhere"), outside, {
        configuredRoot: root,
        basePath: "/ui",
        isAuthorized: allow,
      }),
    ).toBe(false);
  });
});

describe("control UI helpers", () => {
  it("splits cache policy on the assets prefix", () => {
    expect(cacheControlFor("assets/app-abc.js")).toContain("immutable");
    expect(cacheControlFor("index.html")).toBe("no-cache");
    expect(cacheControlFor("bitterbot_avatar.png")).toBe("no-cache");
  });

  it("strips the base path", () => {
    expect(stripBasePath("/ui/a.js", "/ui")).toBe("/a.js");
    expect(stripBasePath("/ui", "/ui")).toBe("/");
    expect(stripBasePath("/other", "/ui")).toBeNull();
    expect(stripBasePath("/a.js", "")).toBe("/a.js");
  });

  it("never offers desktop/dist-renderer as a candidate root", () => {
    // That directory is the raw Vite output, which currently embeds the gateway
    // token. Serving it would route around the staging guard in
    // scripts/control-ui-copy.ts.
    const candidates = controlUiRootCandidates({
      env: {},
      moduleDir: "/repo/dist/gateway",
      cwd: "/repo",
      execPath: "/usr/bin/node",
    });
    expect(candidates.some((c) => c.includes("dist-renderer"))).toBe(false);
    expect(candidates.some((c) => c.endsWith(path.join("dist", "control-ui")))).toBe(true);
  });

  it("notices a UI staged after the first miss", async () => {
    // Regression, found by live testing: a negative result was cached for the
    // process lifetime, so a UI staged after boot (which is exactly what
    // update.run does) was never picked up without a restart.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-cui-late-"));
    dirs.push(root);
    const before = makeRes();
    expect(
      await handleControlUiRequest(makeReq("/"), before, {
        configuredRoot: root,
        isAuthorized: allow,
      }),
    ).toBe(false);

    await fs.writeFile(path.join(root, "index.html"), "STAGED LATE", "utf8");
    resetControlUiRootCache(); // stands in for the 5s negative TTL elapsing

    const after = makeRes();
    expect(
      await handleControlUiRequest(makeReq("/"), after, {
        configuredRoot: root,
        isAuthorized: allow,
      }),
    ).toBe(true);
    expect(after.body).toContain("STAGED LATE");
  });

  it("does not reuse a cached root for a different configured root", async () => {
    // Regression: the root was memoised in a single variable that ignored its
    // inputs, so a changed gateway.controlUi.root kept serving the old directory.
    const first = await makeRoot({ "index.html": "FIRST" });
    const second = await makeRoot({ "index.html": "SECOND" });
    const a = makeRes();
    await handleControlUiRequest(makeReq("/"), a, { configuredRoot: first, isAuthorized: allow });
    const b = makeRes();
    await handleControlUiRequest(makeReq("/"), b, { configuredRoot: second, isAuthorized: allow });
    expect(a.body).toContain("FIRST");
    expect(b.body).toContain("SECOND");
  });

  it("treats an explicit root as authoritative, with no fallbacks", () => {
    const candidates = controlUiRootCandidates({
      configuredRoot: "/explicit",
      env: { BITTERBOT_CONTROL_UI_DIR: "/from-env" },
      moduleDir: "/repo/dist/gateway",
      cwd: "/repo",
      execPath: "/usr/bin/node",
    });
    // An explicit root is authoritative and suppresses the fallbacks entirely.
    expect(candidates).toEqual([path.resolve("/explicit")]);
    expect(
      controlUiRootCandidates({
        env: { BITTERBOT_CONTROL_UI_DIR: "/from-env" },
        moduleDir: "/repo/dist/gateway",
        cwd: "/repo",
        execPath: "/usr/bin/node",
      }),
    ).toEqual([path.resolve("/from-env")]);
  });
});
