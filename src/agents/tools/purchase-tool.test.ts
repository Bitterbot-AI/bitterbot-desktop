import { describe, expect, it } from "vitest";
import { createPurchaseTool } from "./purchase-tool.js";

const privacyOnly = { payments: { privacy: { enabled: true, apiKey: "pk_test" } } };

describe("purchase tool rails", () => {
  it("is absent when no rail is enabled", () => {
    expect(createPurchaseTool({ config: {} })).toBeNull();
  });

  it("refuses a Privacy purchase that does not name its rail, so it cannot skip review", async () => {
    const tool = createPurchaseTool({ config: privacyOnly })!;
    await expect(
      tool.execute("1", {
        action: "request",
        merchant_name: "Shop",
        merchant_url: "https://shop.com",
        amount_usd: 5,
      }),
    ).rejects.toThrow(/rail: "privacy"/);
  });

  it("says Link is off when only Privacy is enabled", async () => {
    const tool = createPurchaseTool({ config: privacyOnly })!;
    await expect(tool.execute("2", { action: "status", rail: "link" })).rejects.toThrow(
      /Link purchases are off/,
    );
  });
});
