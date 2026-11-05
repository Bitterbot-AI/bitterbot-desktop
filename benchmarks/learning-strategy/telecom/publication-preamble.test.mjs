import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runEpisode } from "./episode.mjs";
import { projectFeedback } from "./feedback.mjs";
import { PublicObservationSession, CURRENT_REFERENCES_MARKER } from "./public-observations.mjs";

test("all five recorded v7 formatting failures contain valid explicit references", () => {
  for (const label of [
    "conditional-0-3",
    "conditional-0-35",
    "conditional-1-3",
    "conditional-1-35",
    "conditional-1-30",
  ]) {
    const episode = JSON.parse(
      fs.readFileSync(
        new URL(`../results/telecom-evidence-compliance-v1/episode-${label}.json`, import.meta.url),
        "utf8",
      ),
    );
    const registry = new PublicObservationSession();
    for (const row of episode.transcript) if (row.type === "tool") registry.observeNative(row);
    const failed = episode.transcript.find((r) => r.type === "observation-failure");
    const response = episode.transcript.find((r) => r.id === failed.responseId);
    const calls = response.content.filter((r) => r.type === "tool_use");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "share_observations");
    assert.ok(response.content.some((r) => r.type === "text" && r.text.trim()));
    assert.ok(registry.publish(calls[0].input).records.length > 0);
  }
});

test("a single publication may have a private preamble without leaking it to actor or feedback", async () => {
  let count = 0;
  const call = (name, input = {}) => ({ type: "tool_use", id: name, name, input });
  const episode = await runEpisode({
    index: 28,
    tag: "private-preamble",
    provider: {
      async call(request) {
        count++;
        let content;
        if (count === 1) content = [call("can_send_mms")];
        else if (count === 2) {
          const part = request.messages
            .at(-1)
            .content.find((p) => p.type === "text" && p.text.startsWith(CURRENT_REFERENCES_MARKER));
          const available = JSON.parse(part.text.slice(CURRENT_REFERENCES_MARKER.length));
          content = [
            { type: "text", text: "PRIVATE_PREAMBLE_SENTINEL. I was born on March 15, 1983." },
            call("share_observations", {
              speech: "The requested MMS check failed.",
              observations: available.observations,
            }),
          ];
        } else {
          assert.equal(count, 3);
          assert.ok(!JSON.stringify(request).includes("PRIVATE_PREAMBLE_SENTINEL"));
          assert.ok(!JSON.stringify(request).includes("March 15, 1983"));
          assert.ok(JSON.stringify(request).includes("The requested MMS check failed."));
          content = [call("transfer_to_human_agents", { summary: "End scripted fixture" })];
        }
        return { id: `preamble-${count}`, usd: 0, content, stopReason: "end_turn" };
      },
    },
  });
  assert.equal(episode.reason, "human-transfer");
  assert.equal(episode.transcript.filter((r) => r.type === "public-observations").length, 1);
  assert.ok(!JSON.stringify(episode.publicConversation).includes("PRIVATE_PREAMBLE_SENTINEL"));
  assert.ok(!JSON.stringify(projectFeedback(episode)).includes("PRIVATE_PREAMBLE_SENTINEL"));
  assert.ok(
    JSON.stringify(episode.transcript).includes("PRIVATE_PREAMBLE_SENTINEL"),
    "Raw local response remains auditable",
  );
});
