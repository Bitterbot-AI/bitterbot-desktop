import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  continuityCachePath,
  evaluateContinuityGate,
  getBriefEmbedding,
  resetContinuityGateCache,
} from "./continuity-gate.js";

describe("continuity gate", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "bb-cg-"));
    resetContinuityGateCache();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    resetContinuityGateCache();
  });

  it("embeds the brief once, then serves memory, then disk after a process restart", async () => {
    let calls = 0;
    const embed = async () => {
      calls++;
      return [1, 0];
    };
    const brief = { purpose: "Fix the deploy pipeline" };
    expect((await getBriefEmbedding({ workspaceDir: ws, brief, embed })).source).toBe("embed");
    expect((await getBriefEmbedding({ workspaceDir: ws, brief, embed })).source).toBe("memory");
    expect(fs.existsSync(continuityCachePath(ws))).toBe(true);
    resetContinuityGateCache(); // simulate restart
    expect((await getBriefEmbedding({ workspaceDir: ws, brief, embed })).source).toBe("disk");
    expect(calls).toBe(1);
    // A different purpose (new brief) invalidates the cache.
    await getBriefEmbedding({ workspaceDir: ws, brief: { purpose: "Something else" }, embed });
    expect(calls).toBe(2);
  });

  it("compares the brief with the USER MESSAGE, reusing a caller-supplied message embedding", async () => {
    const embedded: string[] = [];
    const embed = async (text: string) => {
      embedded.push(text);
      return text.includes("deploy") ? [1, 0] : [0, 1];
    };
    const brief = { purpose: "Fix the deploy pipeline" };
    const related = await evaluateContinuityGate({
      workspaceDir: ws,
      brief,
      userMessage: "is the deploy green now?",
      userMessageEmbedding: [1, 0],
      embed,
    });
    expect(related.pass).toBe(true);
    expect(related.embedCalls).toBe(1); // brief only; message embedding reused
    expect(embedded).toEqual([brief.purpose]);

    const unrelated = await evaluateContinuityGate({
      workspaceDir: ws,
      brief,
      userMessage: "write me a birthday poem",
      userMessageEmbedding: [0, 1],
      embed,
    });
    expect(unrelated.pass).toBe(false);
    expect(unrelated.similarity).toBeCloseTo(0);
    expect(unrelated.embedCalls).toBe(0); // brief served from cache
  });

  it("embeds the message itself only when the caller has no embedding", async () => {
    const embedded: string[] = [];
    const embed = async (text: string) => {
      embedded.push(text);
      return [1, 0];
    };
    const r = await evaluateContinuityGate({
      workspaceDir: ws,
      brief: { purpose: "p" },
      userMessage: "q",
      embed,
    });
    expect(r.embedCalls).toBe(2);
    expect(embedded).toEqual(["p", "q"]);
  });

  it("fails open with no message, no embedder, or an embed error", async () => {
    const brief = { purpose: "p" };
    expect(
      (await evaluateContinuityGate({ workspaceDir: ws, brief, embed: async () => [1] })).pass,
    ).toBe(true);
    expect((await evaluateContinuityGate({ workspaceDir: ws, brief, userMessage: "x" })).pass).toBe(
      true,
    );
    const r = await evaluateContinuityGate({
      workspaceDir: ws,
      brief,
      userMessage: "x",
      embed: async () => {
        throw new Error("boom");
      },
    });
    expect(r.pass).toBe(true);
    expect(r.reason).toContain("fail-open");
  });
});
