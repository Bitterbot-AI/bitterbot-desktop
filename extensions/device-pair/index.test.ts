import { describe, expect, it } from "vitest";
import { pickPendingRequest } from "./index.js";

const pending = [
  { requestId: "r1", deviceId: "d1", confirmCode: "472913", ts: 1 },
  { requestId: "r2", deviceId: "d2", confirmCode: "100200", ts: 2 },
];

describe("/pair approve target (PLAN-62)", () => {
  it("picks a phone by the six-digit code it shows, spaces allowed", () => {
    expect(pickPendingRequest(pending, "472 913").request?.requestId).toBe("r1");
    expect(pickPendingRequest(pending, "100-200").request?.requestId).toBe("r2");
  });

  it("refuses a code no pending phone shows", () => {
    expect(pickPendingRequest(pending, "999999").request).toBeUndefined();
  });

  it("asks which one when several wait and none is named", () => {
    expect(pickPendingRequest(pending, "").error).toContain("More than one");
    expect(pickPendingRequest([pending[0]], "").request?.requestId).toBe("r1");
  });

  it("still accepts a request id or latest", () => {
    expect(pickPendingRequest(pending, "r1").request?.requestId).toBe("r1");
    expect(pickPendingRequest(pending, "latest").request?.requestId).toBe("r2");
  });
});

describe("/pair is owner only (PLAN-62)", () => {
  type Handler = (ctx: Record<string, unknown>) => Promise<{ text?: string }>;
  function loadHandler(): Promise<Handler> {
    return import("./index.js").then((mod) => {
      let handler: Handler | undefined;
      mod.default({
        registerCommand: (cmd: { handler: Handler }) => {
          handler = cmd.handler;
        },
        logger: {},
        config: {},
      } as never);
      if (!handler) {
        throw new Error("/pair not registered");
      }
      return handler;
    });
  }

  it.each([false, undefined])(
    "refuses a sender who may chat but is not the owner (senderIsOwner=%s)",
    async (senderIsOwner) => {
      const handler = await loadHandler();
      for (const args of ["", "approve 472913", "status"]) {
        const result = await handler({
          channel: "telegram",
          isAuthorizedSender: true,
          senderIsOwner,
          args,
          commandBody: `/pair ${args}`.trim(),
          config: {},
        });
        expect(result.text).toContain("Only the owner can pair devices");
      }
    },
  );
});
