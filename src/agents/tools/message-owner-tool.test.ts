import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageOwnerTool, resetMessageOwnerForTest } from "./message-owner-tool.js";

beforeEach(() => resetMessageOwnerForTest());

describe("message_owner", () => {
  it("passes the guest's message to the owner, saying who and where", async () => {
    const notify = vi.fn(async () => ({}));
    const tool = createMessageOwnerTool({
      senderName: "Alex",
      senderId: "42",
      channel: "telegram",
      notify,
    });
    const res = await tool.execute("1", { message: "Is Victor free Thursday for coffee?" });
    expect(res.details).toMatchObject({ ok: true });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "guest-message",
        text: "Alex (telegram) asks: Is Victor free Thursday for coffee?",
      }),
    );
  });

  it("stops after a few messages an hour from the same person", async () => {
    const notify = vi.fn(async () => ({}));
    const tool = createMessageOwnerTool({
      senderName: "Alex",
      senderId: "42",
      channel: "telegram",
      notify,
    });
    for (let i = 0; i < 3; i++) await tool.execute(String(i), { message: `ping ${i}` });
    const res = await tool.execute("x", { message: "ping again" });
    expect(res.details).toMatchObject({ ok: false });
    expect(notify).toHaveBeenCalledTimes(3);
    // Someone else is not affected.
    const other = createMessageOwnerTool({
      senderName: "Sam",
      senderId: "7",
      channel: "telegram",
      notify,
    });
    expect((await other.execute("y", { message: "hi" })).details).toMatchObject({ ok: true });
  });
});
