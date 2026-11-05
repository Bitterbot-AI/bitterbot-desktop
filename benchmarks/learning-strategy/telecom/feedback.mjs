import assert from "node:assert/strict";

// This is a projection for the two selected synthetic source customers, not a
// general-purpose anonymizer or authorization to share real user conversations.
export const forbidden =
  /(?:\b(?:Mamadou|Diallo|Priya|Patil)\b|555-\d{3}-\d{4}|\b[CLPBD]\d{4,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\[PERSONA:)/i;
const redact = (text) =>
  text
    .replace(/\b(?:Mamadou Diallo|Priya Patil|Mamadou|Diallo|Priya|Patil)\b/gi, "CUSTOMER")
    .replace(/555-\d{3}-\d{4}/g, "PHONE")
    .replace(/\b[CLPBD]\d{4,}\b/g, "ACCOUNT")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "EMAIL");
const accountFields = [
  "status",
  "account_status",
  "data_used_gb",
  "data_refueling_gb",
  "roaming_enabled",
  "data_limit_gb",
  "data_refueling_price_per_gb",
  "data_used",
  "data_limit",
  "data_remaining",
];

/** Preserve the ordered dialogue the actor actually saw, never private user tools. */
export function projectFeedback(episode) {
  const timeline = [];
  const blocked = new Set(
    episode.transcript
      .filter((row) => ["grounding", "observation-failure"].includes(row.type))
      .map((row) => row.responseId),
  );
  const publicResponses = new Set(
    episode.transcript
      .filter((row) => row.type === "public-observations")
      .map((row) => row.responseId),
  );
  let termination = episode.reason;
  for (const row of episode.transcript) {
    if (
      ["reminder", "grounding", "observation-failure"].includes(row.type) ||
      blocked.has(row.id) ||
      publicResponses.has(row.id)
    )
      continue;
    if (row.type === "public-observations") {
      timeline.push({ speaker: "user", text: redact(row.speech), observations: row.snapshot });
      continue;
    }
    if (row.type === "tool") {
      if (row.seat !== "actor") continue;
      let value;
      try {
        value = JSON.parse(row.content);
      } catch {
        value = {};
      }
      timeline.push({
        tool: row.name,
        error: row.error,
        observed: Object.fromEntries(
          accountFields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]),
        ),
      });
      if (row.name === "transfer_to_human_agents" && !row.error) {
        termination = "human-transfer";
        break;
      }
      continue;
    }
    // Actor-local text is available to the learner; user-local text accompanying
    // tools was never delivered to the actor and must stay excluded.
    const calls = row.content.filter((b) => b.type === "tool_use");
    if (row.seat === "user" && calls.length) continue;
    const text = row.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) timeline.push({ speaker: row.seat, text: redact(text) });
  }
  const result = {
    passed: episode.verdict.passed && !blocked.size,
    termination,
    timeline,
    ...(blocked.size ? { simulationValid: false } : {}),
  };
  assert.ok(!forbidden.test(JSON.stringify(result)), "Synthetic source identifier leaked");
  return result;
}
