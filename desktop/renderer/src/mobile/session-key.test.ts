import { describe, expect, it } from "vitest";
import { newPhoneSessionKey, phoneSessionTag } from "./session-key";

describe("phone conversation keys (PLAN-62)", () => {
  it("tags new conversations with this phone's device id", () => {
    const key = newPhoneSessionKey("A1b2C3d4E5f6a7b8", new Date("2026-11-07T12:34:00Z"), (b) =>
      b.fill(0xab),
    );
    expect(key).toBe("mobile-a1b2c3d4e5f6-202611071234-abababab");
    expect(phoneSessionTag("short")).toBeNull();
    expect(newPhoneSessionKey(undefined)).toBeNull();
  });

  it("gives two New taps in the same minute different conversations", () => {
    const now = new Date("2026-11-07T12:34:00Z");
    const a = newPhoneSessionKey("a1b2c3d4e5f6a7b8", now);
    const b = newPhoneSessionKey("a1b2c3d4e5f6a7b8", now);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^mobile-a1b2c3d4e5f6-202611071234-[0-9a-f]{8}$/);
  });
});
