import { describe, expect, it } from "vitest";
import { currentOrigin } from "./PairPhoneDialog";

describe("pair dialog's own address (PLAN-62)", () => {
  const loc = { protocol: "https:", host: "box.tail1.ts.net", origin: "https://box.tail1.ts.net" };

  it("keeps the gateway's base path in the QR link", () => {
    expect(currentOrigin("abc", "/bitterbot", loc)?.pairUrl).toBe(
      "https://box.tail1.ts.net/bitterbot/m/#pair=abc",
    );
    expect(currentOrigin("abc", "", loc)?.pairUrl).toBe("https://box.tail1.ts.net/m/#pair=abc");
  });

  it("offers nothing from localhost", () => {
    expect(
      currentOrigin("abc", "", { protocol: "http:", host: "127.0.0.1:19001", origin: "x" }),
    ).toBeNull();
  });
});
