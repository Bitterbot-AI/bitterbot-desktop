/**
 * Turning pointer and keyboard events on the live view image into the input
 * events the gateway accepts (PLAN-53 A3). Pure functions: the component owns
 * the listeners, this owns the arithmetic.
 */

export type LiveInputEvent =
  | {
      kind: "mouse";
      type: "down" | "up" | "move";
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
      buttons: number;
      clickCount?: number;
      modifiers: number;
    }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | {
      kind: "key";
      type: "down" | "up";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
      modifiers: number;
    }
  | { kind: "text"; text: string };

type Modifiers = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/** CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(e: Modifiers): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const BUTTON_NAMES = ["left", "middle", "right"] as const;

export function buttonName(button: number): "left" | "middle" | "right" | undefined {
  return BUTTON_NAMES[button];
}

/**
 * Map a point on the displayed image to a point on the page. The image is the
 * page's viewport scaled to fit the pane, so the ratio of the two sizes is the
 * whole conversion.
 */
export function pointOnPage(
  client: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || page.width <= 0 || page.height <= 0) {
    return null;
  }
  const x = ((client.clientX - rect.left) / rect.width) * page.width;
  const y = ((client.clientY - rect.top) / rect.height) * page.height;
  return {
    x: Math.round(Math.min(page.width, Math.max(0, x))),
    y: Math.round(Math.min(page.height, Math.max(0, y))),
  };
}

export function keyInput(
  type: "down" | "up",
  e: Modifiers & { key: string; code: string; keyCode: number },
): LiveInputEvent {
  // A key types a character only when it is one and no command modifier is
  // held: Ctrl+C must reach the page as a shortcut, not as the letter "c".
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  const text =
    type === "down" ? (printable ? e.key : e.key === "Enter" ? "\r" : undefined) : undefined;
  return {
    kind: "key",
    type,
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    ...(text ? { text } : {}),
    modifiers: modifiersOf(e),
  };
}
