import { describe, expect, it } from "vitest";
import { newPhoneSessionKey, phoneSessionTag } from "./session-key";

describe("phone conversation keys (PLAN-62)", () => {
  it("tags new conversations with this phone's device id", () => {
    const key = newPhoneSessionKey("A1b2C3d4E5f6a7b8", new Date("2026-11-07T12:34:00Z"));
    expect(key).toBe("mobile-a1b2c3d4e5f6-202611071234");
    expect(phoneSessionTag("short")).toBeNull();
    expect(newPhoneSessionKey(undefined)).toBeNull();
  });
});
