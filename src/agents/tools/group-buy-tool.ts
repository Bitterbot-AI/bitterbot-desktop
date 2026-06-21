import { Type } from "@sinclair/typebox";
import type { ClearinghouseService } from "../../commerce/clearinghouse.js";
import type { BitterbotConfig } from "../../config/config.js";
import { type KeyPair, makeEnvelope } from "../../commerce/envelope.js";
import { isAubaineEnabled } from "../../commerce/feature.js";
import { canonicalizeSku, type JsonValue } from "../../commerce/sku.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringParam,
  ToolInputError,
} from "./common.js";

const GROUP_BUY_ACTIONS = ["list_offers", "list_syndicates", "register_intent"] as const;

const GroupBuyToolSchema = Type.Object({
  action: stringEnum(GROUP_BUY_ACTIONS, {
    description:
      "list_offers (suppliers' offers for a SKU), list_syndicates (forming/active group buys for a SKU), " +
      "or register_intent (add your standing buy-intent so your agent joins a syndicate when demand covers the MOQ).",
  }),
  sku: Type.Optional(
    Type.String({
      description: "Canonical SKU id (`sha256:...`), e.g. from a list_offers result.",
    }),
  ),
  spec_json: Type.Optional(
    Type.String({
      description:
        "JSON structured spec to canonicalize for a demand-first intent when no SKU exists yet " +
        '(e.g. {"category":"keycap-set","colorway":"nautilus","version":1}). Alternative to `sku`.',
    }),
  ),
  description: Type.Optional(
    Type.String({ description: "Human description of the item (register_intent)." }),
  ),
  max_price_usdc: Type.Optional(
    Type.Number({ description: "Max unit price you will pay in USDC (register_intent)." }),
  ),
  qty: Type.Optional(Type.Number({ description: "Quantity wanted (register_intent, default 1)." })),
  lead_time_max_days: Type.Optional(
    Type.Number({
      description: "Max production lead time you will wait, in days (register_intent).",
    }),
  ),
  buyer_wallet: Type.Optional(
    Type.String({ description: "Your Base wallet address (EIP-3009 payer) for the mandate." }),
  ),
  ttl_days: Type.Optional(
    Type.Number({ description: "Days until this intent expires (register_intent, default 30)." }),
  ),
});

type GroupBuyToolOptions = {
  config?: BitterbotConfig;
  service?: ClearinghouseService;
  signer?: KeyPair;
};

function resolveSku(params: Record<string, unknown>): string {
  const sku = readStringParam(params, "sku");
  if (sku) {
    return sku;
  }
  const specJson = readStringParam(params, "spec_json");
  if (!specJson) {
    throw new ToolInputError("Provide either `sku` or `spec_json`.");
  }
  try {
    return canonicalizeSku(JSON.parse(specJson) as JsonValue);
  } catch {
    throw new ToolInputError("`spec_json` is not valid JSON.");
  }
}

/**
 * The user-facing surface for the Aubaine group-buy layer (PLAN-26 Phase 1).
 * Off unless `commerce.groupbuy.enabled` and a clearinghouse service + signing
 * key are wired in.
 */
export function createGroupBuyTool(opts?: GroupBuyToolOptions): AnyAgentTool | undefined {
  if (!isAubaineEnabled(opts?.config) || !opts?.service || !opts?.signer) {
    return undefined;
  }
  const { service, signer } = opts;

  return {
    label: "Group buy",
    name: "group_buy",
    description: `Join agent-coordinated group buys for custom/made-to-order goods (Aubaine protocol). Actions:
- list_offers: suppliers' offers for a SKU. Requires: sku.
- list_syndicates: forming/active group buys for a SKU and their fill (committed_qty/moq). Requires: sku.
- register_intent: register a standing buy-intent; your agent joins a syndicate automatically once demand covers the MOQ. Requires: sku or spec_json, max_price_usdc, buyer_wallet. Optional: qty (1), lead_time_max_days, ttl_days (30), description.`,
    parameters: GroupBuyToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "list_offers":
          return jsonResult(service.listOffers(resolveSku(params)));

        case "list_syndicates":
          return jsonResult(service.listSyndicates(resolveSku(params)));

        case "register_intent": {
          const sku = resolveSku(params);
          const maxPrice = readNumberParam(params, "max_price_usdc", { required: true });
          const buyerWallet = readStringParam(params, "buyer_wallet", { required: true });
          const qty = readNumberParam(params, "qty") ?? 1;
          const leadTimeMaxDays = readNumberParam(params, "lead_time_max_days") ?? 365;
          const ttlDays = readNumberParam(params, "ttl_days") ?? 30;
          const now = Math.floor(Date.now() / 1000);

          const env = makeEnvelope(
            "intent",
            {
              sku_canonical: sku,
              sku_description: readStringParam(params, "description") ?? sku,
              max_price_usdc: maxPrice,
              qty,
              lead_time_max_days: leadTimeMaxDays,
              expires_at: now + ttlDays * 86_400,
              mandate: {
                max_total_usdc: maxPrice * qty,
                settlement: "eip3009",
                buyer_wallet: buyerWallet,
                chain: "base",
                token: "usdc",
              },
            },
            signer,
            now,
          );
          const result = service.submitIntent(env, now);
          return jsonResult(result);
        }

        default:
          throw new ToolInputError(`Unknown group_buy action: ${action}`);
      }
    },
  };
}
