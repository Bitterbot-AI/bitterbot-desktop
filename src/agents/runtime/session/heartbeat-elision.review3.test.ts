/**
 * Review 3 (2026-10-02): heartbeat-pair elision under the offload policy.
 * Each test pins a defect the review found, now fixed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createContractSession } from "../contract/harness.js";
import { ScriptedModel, type ScriptStep } from "../contract/scripted-model.js";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-review3-"));
  roots.push(dir);
  return dir;
}
const text = (t: string, inputTokens?: number): ScriptStep => ({
  kind: "text",
  text: t,
  inputTokens,
});
function owned(
  script: ScriptedModel,
  extra: Partial<Parameters<typeof createContractSession>[0]> = {},
) {
  return createContractSession({ variant: "bitterbot", dir: tempDir(), script, ...extra });
}
const significant = (events: string[]) =>
  events.filter((e) => !e.startsWith("message_update") && !e.startsWith("message_start"));
const filler = (label: string) => `${label} ${"lorem ipsum dolor sit amet ".repeat(150)}`;
const HEARTBEAT = "HEARTBEAT: check your task list.";

describe("heartbeat-pair elision (review 3)", () => {
  it("a cut at the end of a heartbeat turn keeps the turn that just ran in the live window", async () => {
    const script = new ScriptedModel(
      [
        text("answer one"),
        text("answer two"),
        text("answer three"),
        // The heartbeat turn is the one that crosses 55% of the 10k window.
        text("HEARTBEAT_OK", 6_000),
        text("CHEAP SUMMARY: filler questions."),
      ],
      { contextWindow: 10_000 },
    );
    const s = await owned(script, {
      offload: { settings: { minElidedTokens: 0 }, heartbeatPrompts: [HEARTBEAT] },
    });
    for (const n of ["one", "two", "three"]) {
      await s.prompt(filler(`question ${n}`));
    }
    await s.prompt(HEARTBEAT);
    expect(significant(s.events).slice(-1)).toEqual([
      "compaction_end threshold result=yes aborted=false willRetry=false",
    ]);
    // The embedded runner takes `lastAssistant` from `session.messages` after
    // `prompt()` and reads its usage, stop reason and error as THIS run's
    // outcome, so the reply to the prompt that just returned has to be there.
    expect(s.messages().at(-1)).toBe('assistant[stop] "HEARTBEAT_OK"');
    await s.dispose();
  });

  it("a heartbeat prompt that carries system events is not dropped as a bare pair", async () => {
    // By default a heartbeat runs in the main session only when system events
    // are queued (heartbeat-session.ts shouldRunHeartbeatIsolated); they are
    // prepended as `System: ...` lines (session-updates.ts:138), and
    // `userAuthoredText` strips those lines before classifying the prompt.
    const EVENT = 'System: [2026-10-02 10:00] Node "phone" disconnected (battery 2%)';
    const script = new ScriptedModel(
      [
        text("answer one"),
        text("answer two"),
        text("answer three"),
        text("HEARTBEAT_OK"),
        text("answer four", 6_000),
        text("CHEAP SUMMARY: filler questions."),
        text("answer five"),
      ],
      { contextWindow: 10_000 },
    );
    const s = await owned(script, {
      offload: { settings: { minElidedTokens: 0 }, heartbeatPrompts: [HEARTBEAT] },
    });
    for (const n of ["one", "two", "three"]) {
      await s.prompt(filler(`question ${n}`));
    }
    await s.prompt(`${EVENT}\n\n${HEARTBEAT}`);
    await s.prompt(filler("question four"));
    // The event-carrying prompt is in the kept range. It is not a bare pair,
    // so nothing is recorded for it and it stays in the window.
    const prune = fs
      .readFileSync(s.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((e) => e.type === "custom" && e.customType === "bitterbot.offload-prune") as
      | { data: { stubs: Array<{ kind: string }> } }
      | undefined;
    expect((prune?.data.stubs ?? []).filter((stub) => stub.kind === "heartbeat_pair")).toEqual([]);
    await s.prompt("why is my phone not answering?");
    const next = script.calls.at(-1)!;
    expect(next.messages.some((m) => m.includes("disconnected"))).toBe(true);
    await s.dispose();
  });

  it("a window that is mostly heartbeat pairs shrinks at the turn-end trigger", async () => {
    const bigHeartbeat = (n: number) => filler(`${HEARTBEAT} tick ${n}`);
    const run = async (elideHeartbeats: boolean) => {
      const script = new ScriptedModel(
        [
          ...[1, 2, 3, 4, 5, 6].map(() => text("HEARTBEAT_OK")),
          text("ok one"),
          // Reported prompt size above 55% of the 10k window.
          text("ok two", 6_000),
          // Consumed by the cheap summary only when a cut is planned.
          text("CHEAP SUMMARY: heartbeats."),
          text("ok three"),
        ],
        { contextWindow: 10_000 },
      );
      const s = await owned(script, {
        offload: {
          settings: { minElidedTokens: 0, elideHeartbeats },
          heartbeatPrompts: [HEARTBEAT],
        },
      });
      for (const n of [1, 2, 3, 4, 5, 6]) {
        await s.prompt(bigHeartbeat(n));
      }
      await s.prompt("small one");
      await s.prompt("small two");
      const end = significant(s.events)
        .filter((e) => e.startsWith("compaction_end"))
        .at(-1);
      await s.prompt("small three");
      const sent = script.calls.at(-1)!.messages.filter((m) => m.includes(HEARTBEAT)).length;
      await s.dispose();
      return { end, sent };
    };

    // Heartbeats counted as ordinary turns: a horizon cut.
    const before = await run(false);
    expect(before.end).toBe("compaction_end threshold result=yes aborted=false willRetry=false");
    expect(before.sent).toBeLessThan(6);

    // Heartbeat pairs elided: the window "fits" once they are counted out, so
    // there is no cut, and the pairs are dropped on the no-cut path instead.
    const after = await run(true);
    expect(after.sent).toBe(0);
  });
});
