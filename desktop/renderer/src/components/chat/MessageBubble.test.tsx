import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../stores/chat-store";
import { MessageBubble } from "./MessageBubble";

const reply: ChatMessage = {
  id: "m2",
  role: "assistant",
  content: "The review owner signs off before the pilot starts.",
  timestamp: 0,
};

describe("message", () => {
  it("offers no reply actions on the person's own message", () => {
    render(
      <MessageBubble message={{ id: "m1", role: "user", content: "Summarize", timestamp: 0 }} />,
    );
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("copies the reply text", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<MessageBubble message={reply} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(reply.content);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("says Unavailable for details the gateway did not record", async () => {
    render(<MessageBubble message={reply} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Reply details" }));
    expect((await screen.findAllByText("Unavailable")).length).toBe(4);
  });

  it("shows tokens and cost when they were recorded", async () => {
    render(
      <MessageBubble
        message={{
          ...reply,
          timestamp: Date.UTC(2026, 10, 27, 12, 0),
          usage: { input: 1200, output: 340, total: 1540, cost: 0.0123 },
        }}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Reply details" }));
    await screen.findByText("Cost");
    expect(screen.queryAllByText("Unavailable").length).toBe(0);
  });
});
