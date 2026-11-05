import assert from "node:assert/strict";

export const CUSTOMER_CONTRACT_REVISION = "explicit-conditional-purchase-preference-v1";
const original =
  "You are willing to refuel 2.0 GB of data if necessary, but you do not want to change your mobile data plan.";
const replacement =
  "If extra data is needed to resolve your issue, your purchase preference is exactly 2.0 GB of extra data. Ask for exactly that quantity. If offered a smaller or larger quantity, decline that offer and ask for exactly 2.0 GB instead. Before authorizing a purchase, require the agent to state its total price, then explicitly approve exactly 2.0 GB at that price. Do not agree to a different quantity or a change to your mobile data plan. Do not request extra data when it is not needed.";

/** Explicit benchmark variant. Uses scenario text only, never hidden assertions. */
export function explicitPurchasePreference(context) {
  const copy = structuredClone(context);
  const text = copy.userScenario.instructions.task_instructions;
  assert.equal(typeof text, "string");
  if (/willing to refuel/i.test(text)) {
    assert.equal(
      text.split(original).length,
      2,
      "Unrecognized purchase wording needs qualification",
    );
    copy.userScenario.instructions.task_instructions = text.replace(original, replacement);
  }
  return copy;
}
