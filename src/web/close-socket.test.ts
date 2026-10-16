import { describe, expect, it, vi } from "vitest";
import { closeWaSocketTransport } from "./close-socket.js";

describe("closeWaSocketTransport", () => {
  it("calls ws.close synchronously", () => {
    const close = vi.fn();
    closeWaSocketTransport({ ws: { close } });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("tolerates a missing socket or transport", () => {
    expect(() => closeWaSocketTransport(undefined)).not.toThrow();
    expect(() => closeWaSocketTransport({ ws: null })).not.toThrow();
  });

  it("routes a synchronous throw to onError", () => {
    const onError = vi.fn();
    closeWaSocketTransport(
      {
        ws: {
          close: () => {
            throw new Error("boom");
          },
        },
      },
      onError,
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("catches an async rejection (Baileys rc10+ async close) instead of leaking it", async () => {
    const onError = vi.fn();
    closeWaSocketTransport({ ws: { close: () => Promise.reject(new Error("late")) } }, onError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("does not require onError for a rejecting close", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      closeWaSocketTransport({ ws: { close: () => Promise.reject(new Error("late")) } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
