import { describe, expect, it } from "vitest";
import { buttonName, keyInput, modifiersOf, pointOnPage } from "./browser-live-input";

const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("pointOnPage", () => {
  const page = { width: 1280, height: 800 };

  it("scales a point on the shrunken image up to the page", () => {
    // The pane shows the 1280-wide page at 640 wide: every image pixel is two page pixels.
    const rect = { left: 100, top: 50, width: 640, height: 400 };

    expect(pointOnPage({ clientX: 100 + 320, clientY: 50 + 200 }, rect, page)).toEqual({
      x: 640,
      y: 400,
    });
  });

  it("accounts for where the image sits in the window", () => {
    const rect = { left: 700, top: 120, width: 640, height: 400 };

    expect(pointOnPage({ clientX: 700, clientY: 120 }, rect, page)).toEqual({ x: 0, y: 0 });
  });

  it("clamps a point dragged past the edge", () => {
    const rect = { left: 0, top: 0, width: 640, height: 400 };

    expect(pointOnPage({ clientX: 9000, clientY: -20 }, rect, page)).toEqual({ x: 1280, y: 0 });
  });

  it("gives nothing when the image has no size yet", () => {
    expect(
      pointOnPage({ clientX: 5, clientY: 5 }, { left: 0, top: 0, width: 0, height: 0 }, page),
    ).toBeNull();
    expect(
      pointOnPage(
        { clientX: 5, clientY: 5 },
        { left: 0, top: 0, width: 640, height: 400 },
        { width: 0, height: 0 },
      ),
    ).toBeNull();
  });
});

describe("modifiersOf", () => {
  it("builds the CDP bitmask", () => {
    expect(modifiersOf(none)).toBe(0);
    expect(modifiersOf({ ...none, altKey: true })).toBe(1);
    expect(modifiersOf({ ...none, ctrlKey: true, shiftKey: true })).toBe(10);
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });
});

describe("buttonName", () => {
  it("names the three buttons and nothing else", () => {
    expect([0, 1, 2, 3].map(buttonName)).toEqual(["left", "middle", "right", undefined]);
  });
});

describe("keyInput", () => {
  it("types a character", () => {
    expect(keyInput("down", { ...none, key: "a", code: "KeyA", keyCode: 65 })).toEqual({
      kind: "key",
      type: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      text: "a",
      modifiers: 0,
    });
  });

  it("sends Enter as a carriage return so forms submit", () => {
    expect(keyInput("down", { ...none, key: "Enter", code: "Enter", keyCode: 13 }).kind).toBe(
      "key",
    );
    expect(keyInput("down", { ...none, key: "Enter", code: "Enter", keyCode: 13 })).toMatchObject({
      text: "\r",
    });
  });

  it("does not turn a shortcut into a typed letter", () => {
    const copy = keyInput("down", { ...none, ctrlKey: true, key: "c", code: "KeyC", keyCode: 67 });

    expect(copy).not.toHaveProperty("text");
    expect(copy).toMatchObject({ modifiers: 2 });
  });

  it("sends navigation keys without text", () => {
    expect(
      keyInput("down", { ...none, key: "ArrowDown", code: "ArrowDown", keyCode: 40 }),
    ).not.toHaveProperty("text");
  });

  it("never attaches text to a key release", () => {
    expect(keyInput("up", { ...none, key: "a", code: "KeyA", keyCode: 65 })).not.toHaveProperty(
      "text",
    );
  });
});
