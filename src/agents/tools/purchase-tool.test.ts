import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({
  tabs: vi.fn(async () => [{ targetId: "t1", url: "https://evil.example/pay", title: "" }]),
  act: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../browser/client.js", () => ({ browserTabs: browser.tabs }));
vi.mock("../../browser/client-actions.js", () => ({ browserAct: browser.act }));
const linkCli = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../payments/link/cli.js", async (orig) => ({
  ...(await orig<typeof import("../../payments/link/cli.js")>()),
  createLinkCliRunner: () => linkCli.run,
}));
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

  it("types a Privacy card only into a tab on the approved shop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-purchase-"));
    // os.homedir() reads USERPROFILE on Windows.
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    try {
      const store = path.join(dir, ".bitterbot", "payments", "privacy-cards.json");
      fs.mkdirSync(path.dirname(store), { recursive: true });
      fs.writeFileSync(
        store,
        JSON.stringify([
          {
            id: "prq_1",
            cardToken: "c1",
            merchantName: "Shop",
            merchantUrl: "https://shop.com/cart",
            amountUsd: 10,
            createdAt: Date.now(),
          },
        ]),
      );
      const tool = createPurchaseTool({ config: privacyOnly })!;
      await expect(
        tool.execute("3", {
          action: "fill_card",
          rail: "privacy",
          id: "prq_1",
          number_ref: "e1",
          targetId: "t1",
        }),
      ).rejects.toThrow(/not on shop\.com/);
      expect(browser.act).not.toHaveBeenCalled();
    } finally {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevProfile;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("types a Link card only into a tab on the approved shop", async () => {
    linkCli.run.mockResolvedValue({
      id: "lsrq_1",
      status: "approved",
      merchant_name: "Mug Shop",
      merchant_url: "https://mugs.example",
      amount: 2500,
    });
    const tool = createPurchaseTool({ config: { payments: { link: { enabled: true } } } })!;
    await expect(
      tool.execute("4", { action: "fill_card", id: "lsrq_1", number_ref: "e1", targetId: "t1" }),
    ).rejects.toThrow(/not on mugs\.example/);
    expect(browser.act).not.toHaveBeenCalled();
    // The card was never fetched from Link either.
    expect(linkCli.run.mock.calls.some((c) => (c[0] as string[]).includes("card"))).toBe(false);
  });
});
