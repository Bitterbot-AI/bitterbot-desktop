import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";

const getMemorySearchManager = vi.fn();
vi.mock("../memory/index.js", () => ({
  getMemorySearchManager: (...args: unknown[]) => getMemorySearchManager(...args),
}));

const { startGatewayMemoryBackend } = await import("./server-startup-memory.js");

describe("startGatewayMemoryBackend", () => {
  const cfg = {} as BitterbotConfig;
  let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    getMemorySearchManager.mockReset();
    log = { info: vi.fn(), warn: vi.fn() };
  });

  it("logs disabled memory search as information, not as an unknown failure", async () => {
    getMemorySearchManager.mockResolvedValue({ manager: null });
    const result = await startGatewayMemoryBackend({ cfg, log });
    expect(result.skillNetworkBridge).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("memory search is disabled"));
  });

  it("warns with the real message when initialization threw", async () => {
    getMemorySearchManager.mockResolvedValue({ manager: null, error: "sqlite-vec missing" });
    await startGatewayMemoryBackend({ cfg, log });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("sqlite-vec missing"));
    expect(log.warn.mock.calls[0]?.[0]).not.toContain("unknown error");
  });
});
