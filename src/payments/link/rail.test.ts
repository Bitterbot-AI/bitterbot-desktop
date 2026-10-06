import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { LinkSettings } from "./cli.js";
import { LinkRail } from "./rail.js";

/** A fake Link CLI: records the arguments and answers like the real one. */
let calls: string[][];
let answers: Record<string, unknown>;
let settings: LinkSettings;

const run = async (args: string[]) => {
  calls.push(args);
  const key = args.slice(0, 2).join(" ");
  if (key === "spend-request retrieve" && args.includes("--output-file")) {
    const file = args[args.indexOf("--output-file") + 1];
    await fs.writeFile(
      file,
      JSON.stringify({
        card: {
          number: "4242 4242 4242 4242",
          cvc: "123",
          exp_month: 4,
          exp_year: 2029,
          brand: "visa",
          billing_address: { name: "Victor G" },
        },
      }),
      { mode: 0o600 },
    );
    return { data: { id: args[2], status: "approved", card: { brand: "visa", last4: "4242" } } };
  }
  return answers[key] ?? {};
};

beforeEach(async () => {
  calls = [];
  answers = {};
  const dir = await mkdtemp(path.join(tmpdir(), "link-rail-"));
  settings = {
    enabled: true,
    command: ["link-cli"],
    authFile: path.join(dir, "auth.json"),
    cardDir: path.join(dir, "cards"),
    perPurchaseCapUsd: 100,
  };
});

const context =
  "The owner asked for the blue ceramic mug from this shop for their sister's birthday, $24.50 with standard shipping, delivered to the saved address.";

describe("LinkRail", () => {
  it("reports whether Link is connected", async () => {
    answers["auth status"] = { authenticated: true, scope: "payment_methods.agentic" };
    expect(await new LinkRail(settings, run).status()).toEqual({ connected: true });

    const failing = new LinkRail(settings, async () => {
      throw new Error("not logged in");
    });
    expect(await failing.status()).toEqual({ connected: false, detail: "not logged in" });
  });

  it("starts connecting with Bitterbot's name and returns the link and phrase", async () => {
    answers["auth login"] = {
      verification_uri_complete: "https://app.link.com/device?c=x",
      user_code: "apple-river",
    };

    const started = await new LinkRail(settings, run).connect();

    expect(started).toMatchObject({
      verificationUrl: "https://app.link.com/device?c=x",
      phrase: "apple-river",
    });
    expect(calls[0]).toEqual(["auth", "login", "--client-name", "Bitterbot"]);
  });

  it("asks for one purchase in cents, with approval requested", async () => {
    answers["spend-request create"] = {
      id: "lsrq_1",
      status: "pending_approval",
      merchant_name: "Mug Shop",
      amount: 2450,
      approval_url: "https://app.link.com/a/lsrq_1",
    };

    const view = await new LinkRail(settings, run).request({
      merchantName: "Mug Shop",
      merchantUrl: "https://mugs.example",
      amountUsd: 24.5,
      context,
    });

    expect(view).toEqual({
      id: "lsrq_1",
      status: "pending_approval",
      merchantName: "Mug Shop",
      amountUsd: 24.5,
      approvalUrl: "https://app.link.com/a/lsrq_1",
      nextAction: undefined,
    });
    expect(calls[0]).toEqual(expect.arrayContaining(["--amount", "2450", "--request-approval"]));
  });

  it("refuses a request the owner could not judge", async () => {
    const rail = new LinkRail(settings, run);
    await expect(
      rail.request({
        merchantName: "x",
        merchantUrl: "https://x.example",
        amountUsd: 5,
        context: "a mug",
      }),
    ).rejects.toThrow(/100 characters/);
    await expect(
      rail.request({ merchantName: "x", merchantUrl: "http://x.example", amountUsd: 5, context }),
    ).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  it("takes the card from a private file and deletes the file", async () => {
    const card = await new LinkRail(settings, run).takeCard("lsrq_1");

    expect(card).toMatchObject({
      number: "4242424242424242",
      cvc: "123",
      expMonth: 4,
      expYear: 2029,
      last4: "4242",
    });
    expect(await fs.readdir(settings.cardDir)).toEqual([]);
  });

  it("explains what Link wants when a purchase needs action", async () => {
    answers["spend-request retrieve"] = {
      id: "lsrq_2",
      status: "requires_action",
      status_details: {
        requires_action: {
          next_action: { display_message: "Verify your identity in the Link app." },
        },
      },
    };
    expect((await new LinkRail(settings, run).check("lsrq_2")).nextAction).toBe(
      "Verify your identity in the Link app.",
    );
  });
});
