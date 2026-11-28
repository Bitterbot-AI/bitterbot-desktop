import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// PLAN-65: the palette is a contract. These tests read globals.css directly so
// a token edit that breaks contrast, or lets colour back onto a surface, fails
// here instead of in someone's eyes.

const css = fs.readFileSync(path.join(import.meta.dirname, "globals.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf("\n}\n", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

const themes = { light: block(":root"), dark: block(".dark") };

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["canvas", "sidebar", "raised", "subtle", "hover", "selected"];
const NEUTRALS = [...SURFACES, "ink", "ink-secondary", "ink-muted", "line", "control", "button"];

describe.each(Object.entries(themes))("palette, %s", (_name, t) => {
  it("defines every token", () => {
    for (const name of [...NEUTRALS, "on-button", "link", "focus", "brand", "accent-soft"]) {
      expect(t[name], name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps surfaces, borders and primary buttons neutral", () => {
    // A neutral has near-equal channels. The palette is very slightly warm,
    // so allow a small spread; a purple or blue tint is far outside it.
    for (const name of NEUTRALS) {
      const [r, g, b] = rgb(t[name]);
      expect(Math.max(r, g, b) - Math.min(r, g, b), name).toBeLessThanOrEqual(10);
    }
  });

  it("keeps text readable on every surface", () => {
    for (const surface of SURFACES) {
      for (const ink of ["ink", "ink-secondary", "ink-muted"]) {
        expect(contrast(t[ink], t[surface]), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(t["on-button"], t.button)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["brand-foreground"], t.brand)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the accent, links and status colours readable as text", () => {
    for (const name of ["brand", "link", "success", "warning", "danger"]) {
      for (const surface of ["canvas", "sidebar", "raised", "subtle"]) {
        expect(contrast(t[name], t[surface]), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(t.brand, t["accent-soft"])).toBeGreaterThanOrEqual(4.5);
    for (const status of ["success", "warning", "danger"]) {
      expect(contrast(t[status], t[`${status}-soft`]), status).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(t[`${status}-foreground`], t[status]),
        `${status} fill`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps control outlines and the focus ring visible", () => {
    for (const surface of ["canvas", "sidebar", "raised"]) {
      expect(contrast(t.control, t[surface]), `control on ${surface}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.focus, t[surface]), `focus on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("stylesheet", () => {
  it("has no gradients, blur or glow of its own", () => {
    expect(css).not.toMatch(/gradient\(/);
    expect(css).not.toMatch(/backdrop-filter|blur\(/);
  });
});
