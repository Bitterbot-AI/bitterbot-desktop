// Candidate only. The frozen paid v8 runtime does not import this module.
export function publicationRecovery({ seat, calls, issue, used }) {
  if (
    used !== 0 ||
    seat !== "user" ||
    calls.length !== 1 ||
    calls[0].name !== "share_observations" ||
    issue !== "unknown-or-stale-observation-reference"
  )
    return null;
  return {
    type: "tool_result",
    tool_use_id: calls[0].id,
    is_error: true,
    content:
      "Publication rejected: a selected diagnostic reference is unknown or stale. Nothing from this attempted publication was sent to the support agent. Correct the publication using only the current shareable reference list, omitting stale references. Do not invent replacements or run extra diagnostics unless the support agent asked for them. One correction attempt is available; another invalid publication will end this episode.",
  };
}
