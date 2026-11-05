// Isolated extension of the frozen reminder account join; original evidence stays immutable.
import { PUBLIC_DEVICE_FACTS } from "./public-observations.mjs";
const deviceFacts = [...PUBLIC_DEVICE_FACTS];
const accountFacts = ["account.dataExhausted", "account.roamingEnabled"];
const phoneDigits = (value) => (typeof value === "string" ? value.replace(/\D/g, "") : "");
const quantity = (value) =>
  (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0;

/** Join only observed, owned records for the phone actually used in the lookup. */
export function accountObservations(memory) {
  let customerId, phone, selected;
  let owned = new Set();
  const lines = new Map(),
    plans = new Map(),
    usage = new Map();
  const derive = () => {
    const matches = [...lines.values()].filter(
      ({ value }) =>
        owned.has(value.line_id) &&
        (phone ? phoneDigits(value.phone_number) === phone : owned.size === 1),
    );
    const line = matches.length === 1 ? matches[0] : undefined;
    if (selected !== line?.value.line_id) {
      memory.invalidate([...deviceFacts, ...accountFacts]);
      selected = line?.value.line_id;
    }
    if (!line) {
      memory.invalidate([...accountFacts, "account.lineIdentified"]);
      return;
    }
    memory.observe("account.lineIdentified", true, line.evidence);
    if (typeof line.value.roaming_enabled === "boolean")
      memory.observe("account.roamingEnabled", line.value.roaming_enabled, line.evidence);
    else memory.invalidate(["account.roamingEnabled"]);
    const direct = usage.get(selected),
      plan = plans.get(line.value.plan_id);
    const values = direct
      ? [direct.value.data_used_gb, direct.value.data_limit_gb, direct.value.data_refueling_gb]
      : [line.value.data_used_gb, plan?.value.data_limit_gb, line.value.data_refueling_gb];
    if (!values.every(quantity)) {
      memory.invalidate(["account.dataExhausted"]);
      return;
    }
    const [used, limit, refuel] = values.map(Number);
    memory.observe(
      "account.dataExhausted",
      used >= limit + refuel,
      direct ? direct.evidence : `${line.evidence} + ${plan.evidence}`,
    );
  };
  return (event, evidence) => {
    if (event.error) return;
    const args = event.arguments ?? {};
    if (["refuel_data", "enable_roaming", "disable_roaming"].includes(event.name)) {
      if (args.customer_id !== customerId || !owned.has(args.line_id)) return;
      usage.delete(args.line_id);
      const line = lines.get(args.line_id);
      if (line) {
        // Keep identity for selection, but never revive pre-mutation account facts
        // when an unrelated plan/line is subsequently inspected.
        delete line.value.data_used_gb;
        delete line.value.data_refueling_gb;
        delete line.value.roaming_enabled;
      }
      if (selected === args.line_id) memory.invalidate(accountFacts);
      derive();
      return;
    }
    let value;
    try {
      value = JSON.parse(event.content);
    } catch {
      return;
    }
    if (event.name === "get_customer_by_name" && Array.isArray(value) && value.length === 1)
      [value] = value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (
      [
        "get_customer_by_phone",
        "get_customer_by_id",
        "get_customer_by_name",
        "get_details_by_id",
      ].includes(event.name) &&
      typeof value.customer_id === "string" &&
      Array.isArray(value.line_ids) &&
      value.line_ids.every((id) => typeof id === "string")
    ) {
      const nextPhone =
        event.name === "get_customer_by_phone"
          ? phoneDigits(args.phone_number)
          : customerId === value.customer_id
            ? phone
            : undefined;
      if (
        (customerId !== undefined && customerId !== value.customer_id) ||
        (phone !== undefined && nextPhone !== phone)
      ) {
        memory.reset();
        lines.clear();
        plans.clear();
        usage.clear();
        selected = undefined;
      }
      customerId = value.customer_id;
      phone = nextPhone || undefined;
      owned = new Set(value.line_ids);
      for (const id of lines.keys())
        if (!owned.has(id)) {
          lines.delete(id);
          usage.delete(id);
        }
    } else if (
      event.name === "get_details_by_id" &&
      value.line_id === args.id &&
      owned.has(value.line_id)
    ) {
      lines.set(value.line_id, { value, evidence });
      usage.delete(value.line_id);
    } else if (
      event.name === "get_details_by_id" &&
      typeof value.plan_id === "string" &&
      value.plan_id === args.id
    ) {
      plans.set(value.plan_id, { value, evidence });
      for (const [id, line] of lines) if (line.value.plan_id === value.plan_id) usage.delete(id);
    } else if (
      event.name === "get_data_usage" &&
      args.customer_id === customerId &&
      args.line_id === value.line_id &&
      owned.has(value.line_id)
    ) {
      usage.set(value.line_id, { value, evidence });
    } else return;
    derive();
  };
}
