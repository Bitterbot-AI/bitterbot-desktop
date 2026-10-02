import { describe, expect, it } from "vitest";
import { toCdpInput } from "./live-input.js";

const viewport = { width: 1280, height: 800 };

describe("live view input", () => {
  it("turns a click into press and release at the same point", () => {
    const down = toCdpInput(
      { kind: "mouse", type: "down", x: 200, y: 120, button: "left", buttons: 1 },
      viewport,
    );
    const up = toCdpInput({ kind: "mouse", type: "up", x: 200, y: 120, button: "left" }, viewport);

    expect(down).toEqual({
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: 200,
        y: 120,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      },
    });
    expect(up?.params).toMatchObject({ type: "mouseReleased", x: 200, y: 120, button: "left" });
  });

  it("keeps a point inside the page", () => {
    const cmd = toCdpInput({ kind: "mouse", type: "move", x: 99_999, y: -40 }, viewport);

    expect(cmd?.params).toMatchObject({ type: "mouseMoved", x: 1280, y: 0, button: "none" });
  });

  it("carries the held button on a move so drags work", () => {
    const cmd = toCdpInput(
      { kind: "mouse", type: "move", x: 10, y: 10, button: "left", buttons: 1 },
      viewport,
    );

    expect(cmd?.params).toMatchObject({
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      clickCount: 0,
    });
  });

  it("sends a double click as clickCount 2 and caps it", () => {
    const double = toCdpInput(
      { kind: "mouse", type: "down", x: 1, y: 1, button: "left", clickCount: 2 },
      viewport,
    );
    const absurd = toCdpInput(
      { kind: "mouse", type: "down", x: 1, y: 1, button: "left", clickCount: 500 },
      viewport,
    );

    expect(double?.params.clickCount).toBe(2);
    expect(absurd?.params.clickCount).toBe(3);
  });

  it("scrolls with a bounded wheel delta", () => {
    const cmd = toCdpInput({ kind: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 1e9 }, viewport);

    expect(cmd?.params).toMatchObject({ type: "mouseWheel", deltaX: 0, deltaY: 2000 });
  });

  it("types a character as a key press with text", () => {
    const cmd = toCdpInput(
      { kind: "key", type: "down", key: "a", code: "KeyA", keyCode: 65, text: "a" },
      viewport,
    );

    expect(cmd).toEqual({
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        text: "a",
        unmodifiedText: "a",
        modifiers: 0,
      },
    });
  });

  it("sends a non-printing key without text", () => {
    const down = toCdpInput(
      { kind: "key", type: "down", key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      viewport,
    );
    const up = toCdpInput(
      { kind: "key", type: "up", key: "ArrowDown", code: "ArrowDown", keyCode: 40, text: "x" },
      viewport,
    );

    expect(down?.params).toMatchObject({ type: "rawKeyDown", windowsVirtualKeyCode: 40 });
    expect(down?.params).not.toHaveProperty("text");
    // Key-up never produces a character, whatever the client claims.
    expect(up?.params).toMatchObject({ type: "keyUp" });
    expect(up?.params).not.toHaveProperty("text");
  });

  it("keeps only the four modifier bits", () => {
    const cmd = toCdpInput(
      { kind: "key", type: "down", key: "c", keyCode: 67, modifiers: 2 | 64 },
      viewport,
    );

    expect(cmd?.params.modifiers).toBe(2);
  });

  it("inserts pasted text, bounded", () => {
    const cmd = toCdpInput({ kind: "text", text: "x".repeat(10_000) }, viewport);

    expect(cmd?.method).toBe("Input.insertText");
    expect(cmd?.params.text).toHaveLength(2000);
  });

  it.each([
    ["nothing", null],
    ["a string", "click"],
    ["an unknown kind", { kind: "eval", expression: "document.cookie" }],
    ["a mouse event with no position", { kind: "mouse", type: "down", button: "left" }],
    ["a non-finite position", { kind: "mouse", type: "move", x: Number.NaN, y: 3 }],
    ["a press with no button", { kind: "mouse", type: "down", x: 1, y: 1 }],
    ["an unknown mouse type", { kind: "mouse", type: "teleport", x: 1, y: 1, button: "left" }],
    ["a key with no name", { kind: "key", type: "down", keyCode: 65 }],
    ["empty text", { kind: "text", text: "" }],
  ])("rejects %s", (_label, raw) => {
    expect(toCdpInput(raw, viewport)).toBeNull();
  });

  it("only ever produces the three input methods", () => {
    // The live view must not become a general CDP proxy.
    const samples = [
      { kind: "mouse", type: "down", x: 1, y: 1, button: "left", method: "Runtime.evaluate" },
      { kind: "key", type: "down", key: "a", keyCode: 65, method: "Page.navigate" },
      { kind: "text", text: "hi", method: "Network.getAllCookies" },
      { kind: "wheel", x: 1, y: 1, deltaY: 3 },
    ];
    const methods = new Set(samples.map((s) => toCdpInput(s, viewport)?.method));

    expect([...methods].toSorted()).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchMouseEvent",
      "Input.insertText",
    ]);
  });
});
