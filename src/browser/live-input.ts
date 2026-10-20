/**
 * Pointer and keyboard input from the live view, turned into CDP commands
 * (PLAN-53 A3). Everything arriving here came over the gateway socket from a
 * browser tab, so it is validated field by field and nothing is passed through.
 */

export type CdpInputCommand = {
  method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText";
  params: Record<string, unknown>;
};

const BUTTONS = new Set(["left", "middle", "right"]);
const MAX_TEXT_CHARS = 2_000;
const MAX_WHEEL_DELTA = 2_000;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const within = (value: number, max: number): number =>
  max > 0 ? Math.min(max, Math.max(0, value)) : Math.max(0, value);

/** CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const modifiers = (value: unknown): number => (num(value) ?? 0) & 15;

/**
 * `viewport` is the page's size in CSS pixels, from the last frame. Points are
 * clamped into it so a stray coordinate cannot click outside the page.
 */
export function toCdpInput(
  raw: unknown,
  viewport: { width: number; height: number },
): CdpInputCommand | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const ev = raw as Record<string, unknown>;

  if (ev.kind === "mouse" || ev.kind === "wheel") {
    const x = num(ev.x);
    const y = num(ev.y);
    if (x === null || y === null) {
      return null;
    }
    const point = { x: within(x, viewport.width), y: within(y, viewport.height) };

    if (ev.kind === "wheel") {
      const deltaX = num(ev.deltaX) ?? 0;
      const deltaY = num(ev.deltaY) ?? 0;
      return {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseWheel",
          ...point,
          deltaX: Math.min(MAX_WHEEL_DELTA, Math.max(-MAX_WHEEL_DELTA, deltaX)),
          deltaY: Math.min(MAX_WHEEL_DELTA, Math.max(-MAX_WHEEL_DELTA, deltaY)),
          modifiers: modifiers(ev.modifiers),
        },
      };
    }

    const type =
      ev.type === "down"
        ? "mousePressed"
        : ev.type === "up"
          ? "mouseReleased"
          : ev.type === "move"
            ? "mouseMoved"
            : null;
    if (!type) {
      return null;
    }
    const button = typeof ev.button === "string" && BUTTONS.has(ev.button) ? ev.button : "none";
    if (type !== "mouseMoved" && button === "none") {
      return null;
    }
    return {
      method: "Input.dispatchMouseEvent",
      params: {
        type,
        ...point,
        button,
        // Which buttons are held, so a move with the button down is a drag.
        buttons: (num(ev.buttons) ?? 0) & 7,
        clickCount: type === "mouseMoved" ? 0 : Math.min(3, Math.max(1, num(ev.clickCount) ?? 1)),
        modifiers: modifiers(ev.modifiers),
      },
    };
  }

  if (ev.kind === "key") {
    if (ev.type !== "down" && ev.type !== "up") {
      return null;
    }
    const key = typeof ev.key === "string" ? ev.key.slice(0, 32) : "";
    if (!key) {
      return null;
    }
    const keyCode = Math.min(255, Math.max(0, Math.floor(num(ev.keyCode) ?? 0)));
    // Only a key that produces a character carries text; Enter's is "\r".
    const text =
      ev.type === "down" && typeof ev.text === "string" && ev.text.length > 0
        ? ev.text.slice(0, 4)
        : undefined;
    return {
      method: "Input.dispatchKeyEvent",
      params: {
        type: ev.type === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
        key,
        code: typeof ev.code === "string" ? ev.code.slice(0, 32) : "",
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        ...(text ? { text, unmodifiedText: text } : {}),
        modifiers: modifiers(ev.modifiers),
      },
    };
  }

  if (ev.kind === "text") {
    if (typeof ev.text !== "string" || ev.text.length === 0) {
      return null;
    }
    return { method: "Input.insertText", params: { text: ev.text.slice(0, MAX_TEXT_CHARS) } };
  }

  return null;
}
