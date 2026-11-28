import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chat-store";
import { useDraftStore } from "../../stores/draft-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { ChatInput } from "./ChatInput";

const sendChatText = vi.fn((_text: string) => Promise.resolve("run-1"));
vi.mock("../../lib/chat-send", () => ({ sendChatText: (text: string) => sendChatText(text) }));
// The picker and voice have their own tests; here they are noise.
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./VoiceButton", () => ({ VoiceButton: () => null }));

const request = vi.fn(() => Promise.resolve({}));

beforeEach(() => {
  sendChatText.mockClear();
  request.mockClear();
  useGatewayStore.setState({ status: "connected", request } as never);
  useChatStore.setState({ sessionKey: "a", activeRun: null });
  useDraftStore.setState({ drafts: {}, scroll: {} });
});

const box = () => screen.getByRole("textbox", { name: "Message Bitterbot" }) as HTMLTextAreaElement;

describe("composer", () => {
  it("sends on Enter, clears the draft, and keeps Shift+Enter for a new line", async () => {
    const user = userEvent.setup();
    render(<ChatInput />);
    await user.type(box(), "line one{Shift>}{Enter}{/Shift}line two");
    expect(sendChatText).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(sendChatText).toHaveBeenCalledWith("line one\nline two");
    expect(box().value).toBe("");
  });

  it("does not send on the Enter that confirms an input-method candidate", () => {
    useDraftStore.getState().setDraft("a", "にほん");
    render(<ChatInput />);
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    expect(sendChatText).not.toHaveBeenCalled();
  });

  it("keeps a separate draft for each conversation", async () => {
    const user = userEvent.setup();
    render(<ChatInput />);
    await user.type(box(), "Which step still needs an owner?");
    useChatStore.setState({ sessionKey: "b" });
    await screen.findByDisplayValue("");
    useChatStore.setState({ sessionKey: "a" });
    expect(await screen.findByDisplayValue("Which step still needs an owner?")).toBeTruthy();
  });

  it("keeps the draft editable while disconnected but will not send", async () => {
    useGatewayStore.setState({ status: "connecting" } as never);
    const user = userEvent.setup();
    render(<ChatInput />);
    await user.type(box(), "still typing{Enter}");
    expect(box().value).toBe("still typing");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(sendChatText).not.toHaveBeenCalled();
  });

  it("turns Send into Stop while a reply streams", async () => {
    useChatStore.setState({ activeRun: { runId: "r1", text: "", seq: 0, startedAt: 0 } });
    render(<ChatInput />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
    expect(request).toHaveBeenCalledWith("chat.abort", { sessionKey: "a", runId: "r1" });
  });
});
