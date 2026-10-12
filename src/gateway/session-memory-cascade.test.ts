import { describe, expect, it, vi } from "vitest";
import { deleteSessionWithMemoryCascade } from "./session-memory-cascade.js";

vi.mock("../config/config.js", () => ({ loadConfig: () => ({}) }));

const survivor = { key: "identity.employer", value: "Acme", reason: "owner" as const };

describe("sessions.delete memory cascade (PLAN-55 §3.5b)", () => {
  it("collects the transcript's memories before archiving it, then reports the result", async () => {
    const order: string[] = [];
    const manager = {
      ownerForgetSession: async (files: string[], opts?: { onCollected?: () => void }) => {
        order.push(`collect:${files.join(",")}`);
        opts?.onCollected?.();
        await new Promise((r) => setImmediate(r));
        order.push("cascade");
        return {
          counts: { chunks: 3 },
          retiredFacts: [{ key: "identity.home_city", value: "Lisbon" }],
          survivors: [survivor],
        };
      },
    };
    const result = await deleteSessionWithMemoryCascade({
      agentId: "main",
      files: ["/s/a.jsonl"],
      archive: () => {
        order.push("archive");
        return ["/s/a.jsonl.deleted.1"];
      },
      openManager: async () => manager,
    });
    expect(order).toEqual(["collect:/s/a.jsonl", "archive", "cascade"]);
    expect(result).toEqual({
      archived: ["/s/a.jsonl.deleted.1"],
      memory: {
        ok: true,
        forgottenMemories: 3,
        retiredFacts: [{ key: "identity.home_city", value: "Lisbon" }],
        survivors: [survivor],
      },
    });
  });

  it("answers pending when the cascade waits behind maintenance, and still archives", async () => {
    let finish!: () => void;
    const manager = {
      ownerForgetSession: async (_files: string[], opts?: { onCollected?: () => void }) => {
        opts?.onCollected?.();
        await new Promise<void>((r) => {
          finish = r;
        });
        return { counts: { chunks: 0 }, retiredFacts: [], survivors: [] };
      },
    };
    const archive = vi.fn(() => ["x"]);
    const result = await deleteSessionWithMemoryCascade({
      agentId: "main",
      files: ["/s/a.jsonl"],
      archive,
      waitMs: 10,
      openManager: async () => manager,
    });
    expect(archive).toHaveBeenCalledOnce();
    expect(result.memory).toEqual({ ok: true, pending: true });
    finish();
  });

  it("archives anyway when memory is off, unavailable or the cascade fails", async () => {
    const off = await deleteSessionWithMemoryCascade({
      agentId: "main",
      files: ["/s/a.jsonl"],
      archive: () => ["a"],
      openManager: async () => null,
    });
    expect(off).toEqual({ archived: ["a"], memory: null });

    const broken = await deleteSessionWithMemoryCascade({
      agentId: "main",
      files: ["/s/a.jsonl"],
      archive: () => ["b"],
      openManager: async () => {
        throw new Error("db locked");
      },
    });
    expect(broken).toEqual({ archived: ["b"], memory: { ok: false, error: "db locked" } });

    const failing = await deleteSessionWithMemoryCascade({
      agentId: "main",
      files: ["/s/a.jsonl"],
      archive: () => ["c"],
      openManager: async () => ({
        ownerForgetSession: async () => {
          throw new Error("boom");
        },
      }),
    });
    expect(failing).toEqual({ archived: ["c"], memory: { ok: false, error: "boom" } });

    const noFiles = await deleteSessionWithMemoryCascade({
      agentId: "main",
      files: [],
      archive: () => [],
      openManager: async () => {
        throw new Error("never opened");
      },
    });
    expect(noFiles).toEqual({ archived: [], memory: null });
  });
});
