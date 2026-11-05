import assert from "node:assert/strict";
import { customerGroundingIssue } from "./grounding.mjs";
import { PublicObservationSession } from "./public-observations.mjs";

/** Replay observations, not decisions: recorded actions never change in this diagnostic.
 * Customer tool results and text accompanying tools are private. Final goodbye
 * speech never triggers a new actor call. Preserve the live loop's boundaries.
 */
export function routeRecordedObservations(episode, host, scenario, guard = true) {
  const hits = [];
  const structured = episode.transcript.some(
    (row) => row.type === "public-observations" || row.type === "observation-failure",
  );
  const registry = structured ? new PublicObservationSession() : null;
  let groundingFailure = null;
  for (const [position, row] of episode.transcript.entries()) {
    if (row.type === "observation-failure") {
      groundingFailure = { position, responseId: row.responseId, issue: row.issue };
      break;
    }
    if (row.type === "public-observations") {
      const response = episode.transcript.find((item) => item.id === row.responseId);
      const publication = response.content.find(
        (part) => part.type === "tool_use" && part.name === "share_observations",
      );
      const snapshot = registry.publish(
        publication?.input ?? { speech: row.speech, observations: [] },
      );
      assert.deepEqual(snapshot, row.snapshot);
      host.customerObservations(snapshot);
      continue;
    }
    if (row.type === "tool") {
      registry?.observeNative(row);
      if (row.seat !== "actor") continue;
      host.actorTool(row, `tool-${position}`);
      if (row.name === "transfer_to_human_agents" && !row.error) break;
      continue;
    }
    if (!row.id) continue;
    if (row.seat === "actor") {
      const matches = host.take();
      if (matches.length) hits.push({ beforeTranscriptPosition: position, matches });
    }
    const calls = row.content.filter((part) => part.type === "tool_use");
    const speech = row.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const terminal = row.seat === "user" && calls.some((call) => call.name === "end_conversation");
    if (guard && row.seat === "user" && speech && (!calls.length || terminal)) {
      const issue = customerGroundingIssue(scenario, speech);
      if (issue) {
        groundingFailure = { position, responseId: row.id, issue };
        break;
      }
    }
    if (terminal) break;
    if (calls.length || !speech) continue;
    if (row.seat === "actor") host.actorSpeech(speech);
    else if (!structured) host.customerSpeech(speech, `speech-${position}`);
  }
  return { hits, groundingFailure };
}
