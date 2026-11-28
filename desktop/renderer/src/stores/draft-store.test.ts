import { beforeEach, describe, expect, it } from "vitest";
import { useDraftStore } from "./draft-store";

describe("draft store", () => {
  beforeEach(() => useDraftStore.setState({ drafts: {}, scroll: {} }));

  it("keeps a separate draft for each conversation", () => {
    const { setDraft } = useDraftStore.getState();
    setDraft("a", "Which step still needs an owner?");
    setDraft("b", "other");
    expect(useDraftStore.getState().drafts).toEqual({
      a: "Which step still needs an owner?",
      b: "other",
    });
  });

  it("drops the entry when the draft is cleared", () => {
    const { setDraft } = useDraftStore.getState();
    setDraft("a", "text");
    setDraft("a", "");
    expect("a" in useDraftStore.getState().drafts).toBe(false);
  });

  it("forgets the oldest drafts past the bound, keeping recent edits", () => {
    const { setDraft } = useDraftStore.getState();
    for (let i = 0; i < 60; i++) setDraft(`s${i}`, "x");
    setDraft("s10", "edited again");
    const keys = Object.keys(useDraftStore.getState().drafts);
    expect(keys.length).toBe(50);
    expect(keys).not.toContain("s0");
    expect(keys).toContain("s59");
    expect(keys).toContain("s10");
  });

  it("remembers and forgets the reading position", () => {
    const { setScroll, setDraft, forget } = useDraftStore.getState();
    setScroll("a", 420);
    setDraft("a", "text");
    expect(useDraftStore.getState().scroll.a).toBe(420);
    forget("a");
    expect(useDraftStore.getState().scroll.a).toBeUndefined();
    expect(useDraftStore.getState().drafts.a).toBeUndefined();
  });
});
