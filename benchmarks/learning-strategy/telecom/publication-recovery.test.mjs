import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runEpisode } from "./episode-recovery.mjs";
import { model } from "./provider.mjs";
import { CURRENT_REFERENCES_MARKER } from "./public-observations.mjs";
import { publicationRecovery } from "./publication-recovery.mjs";
const root = "benchmarks/learning-strategy/results/telecom-prerequisite-source-v1";
const read = (n) => JSON.parse(fs.readFileSync(root + "/" + n, "utf8"));
const entries = (label) => {
  const e = read(`episode-${label}.json`);
  return {
    episode: e,
    responses: e.transcript.filter((t) => t.id).map((t) => read(`responses/${t.id}.json`)),
  };
};
async function replay(label, correction) {
  const { episode, responses } = entries(label);
  let cursor = 0,
    corrected = false,
    correctionRequest;
  const arm = label.split("-")[0],
    index = Number(label.split("-").at(-1));
  const result = await runEpisode({
    index,
    strategy: read("protocol.json").actors[arm],
    tag: label,
    maxCalls: 128,
    maxUsd: 3,
    conversationCache: true,
    observationMode: "structured",
    provider: {
      call: async (request, options) => {
        if (cursor < responses.length) {
          const r = responses[cursor++];
          assert.deepEqual({ model, max_tokens: 1024, ...request }, r.request);
          assert.equal(options.tag, r.tag);
          return {
            id: `original-${cursor}`,
            content: r.response.content,
            usd: 0,
            stopReason: r.response.stop_reason,
          };
        }
        if (!corrected) {
          assert.equal(options.tag.split(":").at(-2), "user");
          const last = request.messages.at(-1).content;
          assert.ok(last.some((b) => b.type === "tool_result" && b.is_error));
          const current = JSON.parse(
            last
              .find((b) => b.type === "text" && b.text.startsWith(CURRENT_REFERENCES_MARKER))
              .text.slice(CURRENT_REFERENCES_MARKER.length),
          );
          assert.ok(current.observations.length);
          assert.ok(!current.observations.some((r) => r.fact === "service.mmsBlocked"));
          correctionRequest = structuredClone(request);
          corrected = true;
          const observations = correction
            ? current.observations
            : [{ sourceId: "obs-5", fact: "service.mmsBlocked" }];
          return {
            id: "scripted-correction",
            usd: 0,
            stopReason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "corrected-publication",
                name: "share_observations",
                input: { speech: "Here is my current network report.", observations },
              },
            ],
          };
        }
        assert.equal(options.tag.split(":").at(-2), "actor");
        const visible = JSON.parse(request.messages.at(-1).content);
        assert.equal(visible.kind, "customer-public-report");
        assert.ok(!visible.observations.records.some((r) => r.fact === "service.mmsBlocked"));
        return {
          id: "scripted-stop",
          usd: 0,
          stopReason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "stop",
              name: "transfer_to_human_agents",
              input: { summary: "End offline recovery probe without additional repairs." },
            },
          ],
        };
      },
    },
  });
  return { result, original: episode, cursor, prefixCalls: responses.length, correctionRequest };
}
test("only one customer stale-reference correction is allowed", () => {
  const p = {
    seat: "user",
    calls: [{ name: "share_observations", id: "p" }],
    issue: "unknown-or-stale-observation-reference",
    used: 0,
  };
  assert.equal(publicationRecovery(p).is_error, true);
  for (const change of [
    { seat: "actor" },
    { used: 1 },
    { issue: "unsupported-birth-date" },
    { calls: [...p.calls, ...p.calls] },
  ])
    assert.equal(publicationRecovery({ ...p, ...change }), null);
});
test("recorded stale publication stays private and a corrected publication uses only current refs", async () => {
  const r = await replay("explicit-1-39", true);
  assert.equal(r.cursor, r.prefixCalls);
  assert.equal(r.result.publicationRecoveries, 1);
  assert.equal(r.result.reason, "human-transfer");
  assert.equal(r.result.transcript.filter((t) => t.type === "observation-failure").length, 1);
  assert.equal(r.result.publicConversation.length, r.original.publicConversation.length + 1);
  assert.equal(r.result.verdict.passed, false);
  assert.equal(r.original.verdict.passed, false);
  fs.writeFileSync(
    ".tmp/publication-recovery-request.json",
    JSON.stringify(r.correctionRequest, null, 2) + "\n",
  );
});
test("a second stale publication aborts without delivering either invalid report", async () => {
  const r = await replay("explicit-1-39", false);
  assert.equal(r.result.reason, "simulator-observation-failure");
  assert.equal(r.result.publicationRecoveries, 1);
  assert.equal(r.result.transcript.filter((t) => t.type === "observation-failure").length, 2);
  assert.deepEqual(r.result.publicConversation, r.original.publicConversation);
});
test("no-error historical requests and outcome remain unchanged", async () => {
  const r = await replay("baseline-0-0", true);
  assert.equal(r.result.publicationRecoveries, 0);
  assert.equal(r.result.reason, r.original.reason);
  assert.deepEqual(r.result.publicConversation, r.original.publicConversation);
  assert.deepEqual(r.result.verdict, r.original.verdict);
});
