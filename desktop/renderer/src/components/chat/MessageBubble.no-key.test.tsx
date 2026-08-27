import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../stores/chat-store";
import { useUIStore } from "../../stores/ui-store";
import { isNoApiKeyError, MessageBubble } from "./MessageBubble";

function message(content: string, role: ChatMessage["role"] = "assistant"): ChatMessage {
  return { id: "m1", role, content, timestamp: 0 };
}

describe("no-key first message (PLAN-41 no-key-error)", () => {
  it("isNoApiKeyError matches the gateway's stable prefix only", () => {
    expect(isNoApiKeyError('No API key found for provider "anthropic". Run onboard.')).toBe(true);
    expect(isNoApiKeyError("The model timed out.")).toBe(false);
  });

  it("an assistant no-key error grows a Models & Keys deep link", async () => {
    useUIStore.setState({ activeTab: "chat" });
    render(
      <MessageBubble
        message={message(
          'No API key found for provider "anthropic". No AI provider is configured yet, so the agent can\'t answer.',
        )}
      />,
    );
    const button = screen.getByRole("button", { name: /open models & keys/i });
    await userEvent.click(button);
    expect(useUIStore.getState().activeTab).toBe("models");
  });

  it("ordinary assistant messages get no deep link", () => {
    render(<MessageBubble message={message("All good here.")} />);
    expect(screen.queryByRole("button", { name: /open models & keys/i })).toBeNull();
  });

  it("a USER message quoting the error text gets no deep link", () => {
    render(<MessageBubble message={message('No API key found for provider "x"', "user")} />);
    expect(screen.queryByRole("button", { name: /open models & keys/i })).toBeNull();
  });
});
