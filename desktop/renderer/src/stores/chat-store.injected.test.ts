import { beforeEach, describe, expect, it } from "vitest";
import { isInjectedRunId, useChatStore } from "./chat-store";

const answer = { id: "a1", role: "assistant" as const, content: "Clones: 12", timestamp: 2 };
const note = {
  id: "n1",
  role: "assistant" as const,
  content:
    "You have asked for npm downloads after repo clone metrics twice. Include it every time? (yes / no)",
  timestamp: 3,
};

describe("chat-store addInjectedMessage", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessionKey: "agent:main:main",
      messages: [{ id: "u1", role: "user", content: "clones?", timestamp: 1 }],
      pendingRunCosts: {},
      runMessages: {},
      activeRun: null,
    } as never);
  });

  it("shows a generated note after the reply of an already finalized run", () => {
    const store = useChatStore.getState();
    store.startRun("run-1");
    store.finalizeRun("run-1", answer);
    // The gateway's note is a `final` on a run id of its own: no active run
    // matches it, so finalizeRun alone would drop it.
    useChatStore.getState().finalizeRun("inject-m1", note);
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["u1", "a1"]);

    useChatStore.getState().addInjectedMessage("inject-m1", "agent:main:main", note);
    const state = useChatStore.getState();
    expect(state.messages.map((m) => m.id)).toEqual(["u1", "a1", "n1"]);
    expect(state.messages.at(-1)?.content).toContain("Include it every time? (yes / no)");
    expect(state.activeRun).toBeNull();
  });

  it("shows a repeated broadcast of the same note once", () => {
    const store = useChatStore.getState();
    store.addInjectedMessage("inject-m1", "agent:main:main", note);
    store.addInjectedMessage("inject-m1", "agent:main:main", { ...note, id: "n2" });
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["u1", "n1"]);
  });

  it("ignores a note of another session and a run id that is not an injected one", () => {
    const store = useChatStore.getState();
    store.addInjectedMessage("inject-m1", "agent:main:other", note);
    store.addInjectedMessage("run-9", "agent:main:main", note);
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["u1"]);
    expect(isInjectedRunId("inject-abc")).toBe(true);
    expect(isInjectedRunId("run-1")).toBe(false);
  });

  it("does not disturb a run that is still streaming", () => {
    const store = useChatStore.getState();
    store.startRun("run-2");
    store.appendDelta("run-2", "partial", 1);
    store.addInjectedMessage("inject-m1", "agent:main:main", note);
    const state = useChatStore.getState();
    expect(state.activeRun?.runId).toBe("run-2");
    expect(state.activeRun?.text).toBe("partial");
    expect(state.messages.map((m) => m.id)).toEqual(["u1", "n1"]);
  });
});
