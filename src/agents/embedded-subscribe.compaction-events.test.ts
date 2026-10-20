import { describe, expect, it } from "vitest";
import { subscribeEmbeddedPiSession } from "./embedded-subscribe.js";

type SessionEventHandler = (evt: unknown) => void;

function subscribe() {
  let handler: SessionEventHandler | undefined;
  const session = {
    subscribe: (fn: SessionEventHandler) => {
      handler = fn;
      return () => {};
    },
  } as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];
  const subscription = subscribeEmbeddedPiSession({ session, runId: "run-compaction" });
  return { subscription, emit: (evt: unknown) => handler?.(evt) };
}

// pi-coding-agent >= 0.73 emits compaction_start/compaction_end (formerly
// auto_compaction_*), now also for manual compaction.
describe("compaction session events", () => {
  it("counts automatic compaction and tracks it as in flight", () => {
    const { subscription, emit } = subscribe();
    emit({ type: "compaction_start", reason: "overflow" });
    expect(subscription.isCompacting()).toBe(true);
    emit({
      type: "compaction_end",
      reason: "overflow",
      result: undefined,
      aborted: false,
      willRetry: false,
    });
    expect(subscription.isCompacting()).toBe(false);
    expect(subscription.getCompactionCount()).toBe(1);
  });

  it("ignores manual compaction", () => {
    const { subscription, emit } = subscribe();
    emit({ type: "compaction_start", reason: "manual" });
    expect(subscription.isCompacting()).toBe(false);
    emit({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false });
    expect(subscription.getCompactionCount()).toBe(0);
  });

  it("ignores the pre-0.73 event names", () => {
    const { subscription, emit } = subscribe();
    emit({ type: "auto_compaction_start", reason: "overflow" });
    emit({ type: "auto_compaction_end", aborted: false, willRetry: false });
    expect(subscription.getCompactionCount()).toBe(0);
  });
});
