export const CUSTOMER_GROUNDING =
  "Identity and account facts must come from the scenario's known_info. A persona is not an identity record: never infer a birth date from an age or invent a date, address, customer ID or account value. If a requested identity fact is absent, say that you do not know or do not have it available; do not guess or offer alternative values. Do not invent verification requirements or hidden facts to help the support agent.";

const monthNames = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const dateToken =
  "(?:\\d{4}-\\d{2}-\\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4})";
function birthDates(text) {
  const pattern = new RegExp(
    `\\b(?:date of birth|birth\\s*date|birthday|DOB|born(?:\\s+on)?)\\s*(?:(?:is|was)\\s*|[:=]\\s*)?(${dateToken})\\b`,
    "gi",
  );
  return [...text.matchAll(pattern)].map((match) => {
    const raw = match[1];
    if (/^\d{4}-/.test(raw)) return raw;
    const parts = raw.match(/^(\w+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})$/i);
    const month = monthNames.indexOf(parts[1].slice(0, 3).toLowerCase()) + 1;
    return `${parts[3]}-${String(month).padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
  });
}

/** Bounded simulator-quality guard, not a general factuality or privacy checker.
 * It reads only the customer's declared knowledge, never the account database.
 * These telecom customer tools cannot reveal a birth date. Unsupported date
 * paraphrases remain a documented limitation; no attempt is silently retried.
 */
export function customerGroundingIssue(scenario, speech) {
  const known = new Set(birthDates(scenario.instructions?.known_info ?? ""));
  return birthDates(speech).some((date) => !known.has(date)) ? "unsupported-birth-date" : null;
}
