import assert from "node:assert/strict";
import { accountObservations } from "./prerequisite-account.mjs";
import { PUBLIC_DEVICE_FACTS } from "./public-observations.mjs";

export const TRAVEL_QUESTION = "Are you currently outside your home country?";
export const EXPLICIT_CHECKLIST =
  "For unresolved mobile data or MMS, keep track of verified, unknown and unmet prerequisites. Unknown does not mean false or not applicable. Establish the affected line. If current travel status is unknown, ask: Are you currently outside your home country? Reuse an unambiguous answer; do not infer travel from a roaming switch. If abroad, check account roaming and the device roaming switch separately; change only disabled settings with required consent. Check remaining allowance for the affected line via get_data_usage or its line/plan records; obtain price and consent before refueling. Use current device observations; ask for check_network_status when needed. Preserve normal APN, permissions, SIM and other troubleshooting. After repairs, test the requested service. Before unresolved escalation, review unknown or unmet applicable prerequisites and investigate them when possible. Respect an explicit request for a human, refusal of checks or consent, unavailable tools and genuine limits. Successful service verification ends troubleshooting; do not perform irrelevant extra checks.";
export const LEDGER_MARKER = "Private prerequisite ledger from actor-visible evidence:\n";
const FACTS = [
  "customer.abroad",
  "account.lineIdentified",
  "account.roamingEnabled",
  "account.dataExhausted",
  "device.dataEnabled",
  "device.roamingEnabled",
  "service.mmsBlocked",
];

// Travel is an attributed customer report, never a private native location read.
export function travelReport(speech, previousActorSpeech = "") {
  const values = [];
  const safe = (speech.match(/[^.!?\n]+[.!?]?/g) ?? []).filter(
    (s) =>
      !s.trim().endsWith("?") &&
      !/["“”]/.test(s) &&
      !/\b(if|maybe|might|would|tomorrow|next week|used to|said|says|told|thinks|think)\b/i.test(s),
  );
  for (const sentence of safe) {
    const matches = [
      ...sentence.matchAll(
        /\bI(?:['’]m| am)\s+(?:(?:currently|actually|still|now)\s+)?(not\s+|no longer\s+)?(?:abroad|outside (?:of )?my home country|travell?ing (?:internationally|abroad))\b/gi,
      ),
    ];
    for (const m of matches) values.push(!m[1]);
    if (
      /\bI(?:['’]m| am)\s+(?:(?:currently|actually|still|now)\s+)?(?:at home in|in my home country)\b/i.test(
        sentence,
      )
    )
      values.push(false);
  }
  // Only a reply to the one explicit, unambiguous question supports bare yes/no.
  const question = previousActorSpeech.trim();
  if (question === TRAVEL_QUESTION) {
    if (/^(?:yes|yeah|correct)\b/i.test(speech.trim())) values.push(true);
    if (/^(?:no|nope)\b/i.test(speech.trim())) values.push(false);
  }
  const distinct = new Set(values);
  return distinct.size === 1 ? [...distinct][0] : "unknown";
}

/** Reconstruct only from the actor's role-separated input; no task or private tools. */
export function prerequisiteSnapshot(messages) {
  const facts = new Map();
  const memory = {
    observe: (key, value, evidence) => {
      assert.equal(typeof value, "boolean");
      facts.set(key, { value, evidence });
    },
    invalidate: (keys) => keys.forEach((k) => facts.delete(k)),
    reset: () => facts.clear(),
  };
  const account = accountObservations(memory);
  let previousActorSpeech = "",
    publicReport = null;
  const calls = new Map();
  for (const [i, message] of messages.entries()) {
    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      calls.clear();
      for (const b of blocks) if (b.type === "tool_use") calls.set(b.id, b);
      // Text accompanying a tool call was never spoken to the customer.
      if (!calls.size)
        previousActorSpeech = blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      continue;
    }
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      let report;
      try {
        report = JSON.parse(message.content);
      } catch {
        continue;
      }
      if (
        report?.kind !== "customer-public-report" ||
        typeof report.speech !== "string" ||
        report.observations?.schemaVersion !== 1
      )
        continue;
      publicReport = report.observations.reportId;
      memory.invalidate(PUBLIC_DEVICE_FACTS);
      for (const row of report.observations.records)
        if (PUBLIC_DEVICE_FACTS.includes(row.fact) && typeof row.value === "boolean")
          memory.observe(
            row.fact,
            row.value,
            `${publicReport}/${row.sourceId}/${row.fact}@${row.revision}`,
          );
      const travel = travelReport(report.speech, previousActorSpeech);
      if (travel !== "unknown")
        memory.observe("customer.abroad", travel, `${publicReport}/customer-speech`);
      // Explicit contradictory travel claims remove previous certainty.
      else if (/\bI(?:['’]m| am)\b.*\b(?:abroad|home country)\b/i.test(report.speech))
        memory.invalidate(["customer.abroad"]);
      continue;
    }
    for (const b of message.content ?? []) {
      if (b.type !== "tool_result") continue;
      const call = calls.get(b.tool_use_id);
      if (!call) continue;
      if (["enable_roaming", "disable_roaming", "refuel_data"].includes(call.name))
        memory.invalidate(PUBLIC_DEVICE_FACTS);
      account(
        { name: call.name, arguments: call.input, content: b.content, error: !!b.is_error },
        `actor-message-${i}/${call.name}`,
      );
    }
  }
  const state = Object.fromEntries(
    FACTS.map((k) => [k, facts.get(k) ?? { value: "unknown", evidence: null }]),
  );
  const value = (k) => state[k].value;
  const pending = [];
  if (value("service.mmsBlocked") !== false) {
    if (value("customer.abroad") === "unknown")
      pending.push(
        `Travel applicability UNKNOWN. If still troubleshooting and no clear answer exists in dialogue, ask exactly: ${TRAVEL_QUESTION}`,
      );
    if (value("account.lineIdentified") === "unknown")
      pending.push(
        "Affected line UNKNOWN: verify the customer's affected phone against owned line records.",
      );
    if (value("account.dataExhausted") === "unknown")
      pending.push("Allowance UNKNOWN: inspect affected-line usage/limit.");
    else if (value("account.dataExhausted"))
      pending.push(
        "Allowance EXHAUSTED: follow pricing and consent before refueling; confirm the result.",
      );
    if (value("customer.abroad") === true) {
      for (const key of ["account.roamingEnabled", "device.roamingEnabled"])
        if (value(key) !== true)
          pending.push(
            `${key}: ${value(key) === false ? "DISABLED; repair with required consent" : "UNKNOWN; verify before changing"}. Account and device switches are separate prerequisites.`,
          );
    }
    if (value("device.dataEnabled") !== true)
      pending.push(
        `Device data switch ${value("device.dataEnabled") === false ? "DISABLED" : "UNKNOWN"}; use current network diagnostics, then change only when needed.`,
      );
  }
  return {
    version: 1,
    publicReport,
    facts: state,
    pending,
    note: "Travel is a bounded interpretation of public customer speech; missing/ambiguous wording remains unknown. An unambiguous answer elsewhere in the dialogue takes precedence over parser uncertainty: do not repeatedly ask. Device records come only from the latest explicit publication. Account facts come from owned affected-line tool results. This ledger is advisory, not permission to mutate or a restriction on human handoff. Apply it only to the current service problem; stop after verified success.",
  };
}

export function withPrerequisiteLedger(request) {
  const snapshot = prerequisiteSnapshot(request.messages),
    messages = structuredClone(request.messages),
    last = messages.at(-1);
  assert.equal(last?.role, "user");
  if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
  last.content.push({ type: "text", text: LEDGER_MARKER + JSON.stringify(snapshot) });
  return { request: { ...request, messages }, snapshot };
}

export function prerequisiteProvider(provider, mode, onLedger = () => {}) {
  assert.ok(["baseline", "explicit", "ledger"].includes(mode));
  return {
    call: async (request, options) => {
      if (mode !== "ledger" || options.tag.split(":").at(-2) !== "actor")
        return provider.call(request, options);
      const projected = withPrerequisiteLedger(request);
      onLedger({ tag: options.tag, snapshot: projected.snapshot });
      return provider.call(projected.request, options);
    },
  };
}
