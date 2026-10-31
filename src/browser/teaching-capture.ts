/**
 * Semantic capture for the owner's live-browser demonstration. Inspired by
 * CopilotKit/OpenDuet's MIT demonstration recorder; implemented for Bitterbot's
 * CDP input path. See ATTRIBUTION.md. Values, images and raw keys never leave
 * the page in the captured action. Page labels are still private source data.
 */
import type { Page } from "playwright-core";
import type { CdpInputCommand } from "./live-input.js";
import { teachingActionSchema, type TeachingAction } from "./teaching-types.js";

export function teachingUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname
      .split("/")
      .map((part) =>
        part.length > 40 || /@|%40|token|secret|password|credential|\d{6}/i.test(part)
          ? "_private_"
          : part,
      )
      .join("/");
    return url.href.length <= 2000 ? url.href : url.origin;
  } catch {
    return null;
  }
}

function gesture(command: CdpInputCommand): Partial<TeachingAction> | null {
  const p = command.params;
  if (command.method === "Input.insertText") return { kind: "type" };
  if (command.method === "Input.dispatchMouseEvent") {
    if (p.type === "mouseWheel") {
      const y = Number(p.deltaY) || 0;
      const x = Number(p.deltaX) || 0;
      return {
        kind: "scroll",
        direction: Math.abs(y) >= Math.abs(x) ? (y < 0 ? "up" : "down") : x < 0 ? "left" : "right",
      };
    }
    // Capture before mouse-down: mouse-up can arrive on a new page after a
    // navigation. Pointer motion and releases are not additional steps.
    if (p.type === "mouseMoved" && Number(p.buttons)) return { kind: "manual" };
    if (p.type !== "mousePressed") return null;
    return {
      kind: p.button === "left" && p.clickCount === 1 && !Number(p.modifiers) ? "click" : "manual",
    };
  }
  if (p.type === "keyUp") return null;
  const key = typeof p.key === "string" ? p.key : "";
  if ((Number(p.modifiers) & 7) !== 0) {
    // A shortcut may copy, paste, select or invoke browser chrome. Do not
    // pretend a secret-free character trace describes its effects.
    return ["Control", "Meta", "Alt", "Shift"].includes(key) ? null : { kind: "manual" };
  }
  if (key.length === 1 || key === "Backspace" || key === "Delete") return { kind: "type" };
  if ((Number(p.modifiers) & 8) !== 0 && key !== "Shift") return { kind: "manual" };
  const parsed = teachingActionSchema.shape.key.safeParse(key);
  if (parsed.success && parsed.data) return { kind: "key", key: parsed.data };
  return ["Control", "Meta", "Alt", "Shift", "CapsLock"].includes(key) ? null : { kind: "manual" };
}

/** Describe the target BEFORE delivery, while it still exists. */
export async function describeTeachingInput(
  page: Page,
  command: CdpInputCommand,
): Promise<TeachingAction | null> {
  const action = gesture(command);
  if (!action) return null;
  const url = teachingUrl(page.url());
  if (!url) throw new Error("Recording supports web pages only.");
  const point =
    command.method === "Input.dispatchMouseEvent"
      ? { x: Number(command.params.x), y: Number(command.params.y) }
      : null;
  const target = await page.evaluate((point) => {
    const hit = point ? document.elementFromPoint(point.x, point.y) : document.activeElement;
    const closest =
      hit?.closest("button,a,input,textarea,select,label,[role],[contenteditable=true]") ?? hit;
    const element = closest instanceof HTMLLabelElement ? (closest.control ?? closest) : closest;
    const tag = element?.tagName.toLowerCase() ?? "page";
    const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
    const explicitRole = element?.getAttribute("role");
    const role =
      explicitRole ||
      (
        {
          checkbox: "checkbox",
          radio: "radio",
          submit: "button",
          button: "button",
          range: "slider",
        } as Record<string, string>
      )[type] ||
      (
        {
          a: "link",
          button: "button",
          input: "textbox",
          textarea: "textbox",
          select: "combobox",
        } as Record<string, string>
      )[tag] ||
      "page";
    const labelledBy = (element?.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const label =
      element?.getAttribute("aria-label") ||
      labelledBy ||
      (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? Array.from(element.labels ?? [])
            .map((entry) => entry.textContent ?? "")
            .join(" ")
        : "") ||
      (["button", "a"].includes(tag) ? element?.textContent : "") ||
      element?.getAttribute("placeholder") ||
      role;
    const sensitive =
      type === "password" ||
      /password|secret|token|one.time|verification|credit.card|security.code|passcode|\b(?:cvc|cvv|pin|otp|cc-number|cc-csc)\b/i.test(
        [label, element?.getAttribute("name"), element?.getAttribute("autocomplete")].join(" "),
      );
    const name = sensitive
      ? "sensitive field"
      : label
          .replace(/\S+@\S+|[A-Za-z0-9_+/=-]{32,}|\d{6,}/g, "[private]")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
    // Iframes, file pickers and editable page bodies need a human-described
    // step; no document contents or filesystem paths are collected.
    return {
      role: role.slice(0, 40),
      name: name || role,
      sensitive,
      manual:
        tag === "iframe" ||
        tag === "select" ||
        type === "range" ||
        type === "color" ||
        type === "file" ||
        element?.getAttribute("contenteditable") === "true" ||
        role === "page",
    };
  }, point);
  return teachingActionSchema.parse({
    ...action,
    url,
    role: target.role,
    name: target.name,
    sensitive: target.sensitive,
    ...((target.manual || (action.kind === "type" && target.role !== "textbox")) &&
    action.kind !== "scroll"
      ? { kind: "manual", key: undefined }
      : {}),
  });
}
