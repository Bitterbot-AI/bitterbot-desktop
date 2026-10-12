import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleMemoryExportHttpRequest,
  MEMORY_EXPORT_TOKEN_TTL_MS,
  mintMemoryExportToken,
  resetMemoryExportTokensForTest,
} from "./memory-export-http.js";

/** A response that records writes and applies backpressure every other write. */
function fakeRes() {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  let writes = 0;
  const res = Object.assign(emitter, {
    statusCode: 0,
    destroyed: false,
    writableEnded: false,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    write: (piece: string) => {
      chunks.push(piece);
      writes += 1;
      if (writes % 2 === 0) {
        setImmediate(() => emitter.emit("drain"));
        return false;
      }
      return true;
    },
    end: (piece?: string) => {
      if (piece) chunks.push(piece);
      res.writableEnded = true;
    },
    destroy: () => {
      res.destroyed = true;
    },
  });
  return { res: res as unknown as ServerResponse & { writableEnded: boolean }, chunks, headers };
}

const req = (url: string, method = "GET") => ({ url, method, headers: {} }) as IncomingMessage;

beforeEach(() => resetMemoryExportTokensForTest());

describe("memory export download", () => {
  it("streams the export once per token, in pieces, as an attachment", async () => {
    const link = mintMemoryExportToken("main");
    const { res, chunks, headers } = fakeRes();
    const source = {
      ownerExportTo: async (sink: (p: string) => void | Promise<void>) => {
        for (const piece of ['{"version":2,', '"memories":[', "]}"]) await sink(piece);
        return { memories: 0, facts: 0, bytes: 20, redactions: 0 } as never;
      },
    };
    expect(
      await handleMemoryExportHttpRequest(req(link.path), res, {
        openExportSource: async () => source,
      }),
    ).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(chunks.join(""))).toEqual({ version: 2, memories: [] });
    expect(chunks.length).toBeGreaterThan(1);
    expect(headers["content-disposition"]).toMatch(/^attachment; filename="bitterbot-memory-main-/);
    expect(headers["cache-control"]).toBe("no-store");

    const second = fakeRes();
    await handleMemoryExportHttpRequest(req(link.path), second.res, {
      openExportSource: async () => source,
    });
    expect(second.res.statusCode).toBe(404);
  });

  it("refuses unknown and expired tokens, and other methods", async () => {
    const unknown = fakeRes();
    await handleMemoryExportHttpRequest(req("/api/memory/export/nope"), unknown.res);
    expect(unknown.res.statusCode).toBe(404);

    const link = mintMemoryExportToken("main", 1_000);
    const expired = fakeRes();
    await handleMemoryExportHttpRequest(req(link.path), expired.res, {
      now: () => 1_000 + MEMORY_EXPORT_TOKEN_TTL_MS + 1,
    });
    expect(expired.res.statusCode).toBe(404);

    const post = fakeRes();
    await handleMemoryExportHttpRequest(req(mintMemoryExportToken("main").path, "POST"), post.res);
    expect(post.res.statusCode).toBe(405);
  });

  it("removes its drain/close listeners after every wait (no leak over a long download)", async () => {
    const link = mintMemoryExportToken("main");
    const { res } = fakeRes();
    const emitter = res as unknown as EventEmitter;
    let maxListeners = 0;
    const source = {
      ownerExportTo: async (sink: (p: string) => void | Promise<void>) => {
        for (let i = 0; i < 602; i++) {
          await sink("x");
          maxListeners = Math.max(
            maxListeners,
            emitter.listenerCount("drain"),
            emitter.listenerCount("close"),
          );
        }
        return { memories: 0, facts: 0, bytes: 602, redactions: 0 } as never;
      },
    };
    await handleMemoryExportHttpRequest(req(link.path), res, {
      openExportSource: async () => source,
    });
    expect(res.statusCode).toBe(200);
    expect(maxListeners).toBe(0);
    expect(emitter.listenerCount("drain")).toBe(0);
    expect(emitter.listenerCount("close")).toBe(0);
    expect(emitter.listenerCount("error")).toBe(0);
  });

  it("stops the export when the response errors while waiting to drain", async () => {
    const link = mintMemoryExportToken("main");
    const { res } = fakeRes();
    const emitter = res as unknown as EventEmitter;
    (res as unknown as { write: () => boolean }).write = () => {
      setImmediate(() => emitter.emit("error", new Error("EPIPE")));
      return false;
    };
    let pieces = 0;
    const source = {
      ownerExportTo: async (sink: (p: string) => void | Promise<void>) => {
        for (let i = 0; i < 5; i++) {
          await sink("x");
          pieces += 1;
        }
        return { memories: 0, facts: 0, bytes: 5, redactions: 0 } as never;
      },
    };
    await handleMemoryExportHttpRequest(req(link.path), res, {
      openExportSource: async () => source,
    });
    expect(pieces).toBe(0);
    expect(res.destroyed).toBe(true);
  });

  it("serves the download under the Control UI base path", async () => {
    const link = mintMemoryExportToken("main");
    const { res, chunks } = fakeRes();
    const source = {
      ownerExportTo: async (sink: (p: string) => void | Promise<void>) => {
        await sink("{}");
        return { memories: 0, facts: 0, bytes: 2, redactions: 0 } as never;
      },
    };
    expect(
      await handleMemoryExportHttpRequest(req(`/bb${link.path}`), res, {
        openExportSource: async () => source,
        basePath: "/bb",
      }),
    ).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(chunks.join("")).toBe("{}");
  });

  it("ignores other paths", async () => {
    expect(await handleMemoryExportHttpRequest(req("/api/other"), fakeRes().res)).toBe(false);
  });
});
