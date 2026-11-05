import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { MISSING_DIAGNOSTIC_REMINDERS } from "./diagnostic-observations.mjs";
import { runEpisode } from "./episode.mjs";
import {
  CURRENT_REFERENCES_MARKER,
  PublicObservationSession,
  withCurrentReferences,
} from "./public-observations.mjs";
import { createTelecomReminders } from "./reminders.mjs";

const readEpisode = (index) =>
  JSON.parse(
    fs.readFileSync(
      new URL(
        `../results/telecom-public-observation-compliance-v1/episode-conditional-0-${index}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
const content = (name, input = {}) => [{ type: "tool_use", id: name, name, input }];
function catalog(request) {
  const matches = request.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((p) => p.type === "text" && p.text.startsWith(CURRENT_REFERENCES_MARKER));
  assert.equal(matches.length, 1, "Only the current private catalog belongs in the request");
  return JSON.parse(matches[0].text.slice(CURRENT_REFERENCES_MARKER.length));
}

test("the recorded stale-reference failure exposes only the new MMS source after reboot", () => {
  const episode = readEpisode(29),
    session = new PublicObservationSession();
  for (const event of episode.transcript) if (event.type === "tool") session.observeNative(event);
  const failure = episode.transcript.find((r) => r.type === "observation-failure");
  const input = episode.transcript
    .find((r) => r.id === failure.responseId)
    .content.find((b) => b.name === "share_observations").input;
  assert.deepEqual(session.currentReferences().observations, [
    { sourceId: "obs-3", fact: "service.mmsBlocked" },
  ]);
  assert.throws(() => session.publish(input), /stale/);
  const available = session.currentReferences();
  available.observations[0].sourceId = "forged";
  assert.equal(session.currentReferences().observations[0].sourceId, "obs-3");
  assert.equal(
    session.publish({
      speech: "Current check only",
      observations: session.currentReferences().observations,
    }).records.length,
    1,
  );
});

test("surviving earlier signal is available to select but never automatically published", () => {
  const episode = readEpisode(33),
    session = new PublicObservationSession();
  let checked = 0;
  for (const event of episode.transcript) {
    if (event.type === "tool") session.observeNative(event);
    if (
      event.type !== "public-observations" ||
      !event.snapshot.records.some((r) => r.sourceId === "obs-5")
    )
      continue;
    const available = session.currentReferences().observations;
    assert.ok(
      available.some((r) => r.sourceId === "obs-3" && r.fact === "device.strongCellularSignal"),
    );
    assert.ok(available.some((r) => r.sourceId === "obs-5" && r.fact === "service.mmsBlocked"));
    const host = createTelecomReminders(MISSING_DIAGNOSTIC_REMINDERS, { structured: true });
    const explicit = event.snapshot.records.map(({ sourceId, fact }) => ({ sourceId, fact }));
    host.customerObservations(
      session.publish({ speech: "Only the selected MMS check", observations: explicit }),
    );
    assert.deepEqual(host.take(), []);
    checked++;
  }
  assert.equal(checked, 1);
});

test("request-local catalogs leave conversation history unchanged and refresh on every call", () => {
  const session = new PublicObservationSession();
  session.observeNative({
    seat: "user",
    name: "can_send_mms",
    content: "Your messaging app cannot send MMS messages.",
    error: false,
  });
  for (const last of [
    "Please report",
    [{ type: "tool_result", tool_use_id: "check", content: "Original result" }],
  ]) {
    const messages = [{ role: "user", content: last }],
      before = structuredClone(messages);
    const first = withCurrentReferences(messages, session);
    assert.equal(catalog({ messages: first }).observations.length, 1);
    assert.deepEqual(messages, before);
    first.at(-1).content.push({ type: "text", text: "caller mutation" });
    assert.deepEqual(messages, before);
  }
  session.observeNative({ seat: "user", name: "reboot_device", content: "Rebooted", error: false });
  const request = {
    messages: withCurrentReferences([{ role: "user", content: "Ready" }], session),
  };
  assert.deepEqual(catalog(request).observations, []);
});

test("native runtime keeps catalogs customer-private and refreshes them after actor scope changes", async () => {
  let calls = 0;
  const result = await runEpisode({
    index: 28,
    tag: "catalog-scope",
    provider: {
      async call(request, options) {
        calls++;
        const seat = options.tag.split(":")[1];
        if (seat === "actor")
          assert.ok(!JSON.stringify(request).includes(CURRENT_REFERENCES_MARKER));
        let blocks;
        if (calls === 1) {
          assert.deepEqual(catalog(request).observations, []);
          blocks = [...content("check_network_status"), ...content("can_send_mms")];
        } else if (calls === 2) {
          assert.equal(catalog(request).observations.length, 4);
          blocks = [{ type: "text", text: "Please inspect my account." }];
        } else if (calls === 3)
          blocks = content("get_customer_by_phone", { phone_number: "555-123-2002" });
        else if (calls === 4) blocks = [{ type: "text", text: "The account lookup has finished." }];
        else {
          assert.equal(calls, 5);
          assert.deepEqual(catalog(request), { scope: 1, observations: [] });
          blocks = content("end_conversation");
        }
        return { id: `catalog-${calls}`, usd: 0, content: blocks, stopReason: "end_turn" };
      },
    },
  });
  assert.equal(result.reason, "user-ended");
  assert.equal(result.cost.providerUsd, 0);
  assert.ok(!JSON.stringify(result.publicConversation).includes(CURRENT_REFERENCES_MARKER));
  assert.ok(
    result.transcript
      .filter((r) => r.type === "public-observations")
      .every((r) => !r.snapshot.records.length),
  );
});
