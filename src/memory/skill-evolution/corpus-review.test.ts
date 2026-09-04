import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingCorpusPath } from "./corpus-miner.js";
import {
  acceptDrafts,
  flagDraft,
  listPendingDrafts,
  rejectDrafts,
  rejectedCorpusPath,
  reviewedDraftIds,
} from "./corpus-review.js";
import { corpusPath, loadTaskCorpus } from "./task-corpus.js";

function draft(id: string, prompt: string, value = "42"): string {
  return JSON.stringify({
    id,
    prompt,
    checker: { kind: "final", value },
    suite: "capability",
    tags: ["mined"],
  });
}

describe("corpus review (PLAN-44 Phase 2)", () => {
  let tmpDir: string;
  const opts = () => ({ configDir: tmpDir });
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-review-"));
    await fs.mkdir(path.dirname(pendingCorpusPath(opts())), { recursive: true });
    await fs.writeFile(
      pendingCorpusPath(opts()),
      [
        draft(
          "good-1",
          'Count the words in "a b c". Reply with exactly one line "FINAL: <answer>".',
          "3",
        ),
        draft("abs-path", "Read /tmp/test_workspace/README.md and report its first line."),
        draft("network", "Run curl https://example.com and report the status code."),
        draft("err-checker", "Run git status here.", "fatal: not a git repository"),
        draft("good-2", "Reverse the string abc. Reply FINAL: <answer>.", "cba"),
      ].join("\n") + "\n",
      "utf-8",
    );
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("flags non-hermetic and brittle drafts", () => {
    expect(
      flagDraft({
        id: "x",
        prompt: "Read /home/me/secret.txt and curl http://evil.invalid",
        checker: { kind: "final", value: "Error: nope" },
      }),
    ).toEqual(["absolute-path", "network-verb", "checker-looks-like-error"]);
    expect(
      flagDraft({ id: "y", prompt: "add 2 and 2", checker: { kind: "contains", value: "4" } }),
    ).toEqual(["not-final-checker"]);
  });

  it("lists drafts with flags and acceptability", async () => {
    const drafts = await listPendingDrafts(opts());
    expect(drafts.map((d) => d.id)).toEqual([
      "good-1",
      "abs-path",
      "network",
      "err-checker",
      "good-2",
    ]);
    expect(drafts.find((d) => d.id === "good-1")?.acceptable).toBe(true);
    expect(drafts.find((d) => d.id === "abs-path")?.flags).toContain("absolute-path");
    expect(drafts.find((d) => d.id === "network")?.flags).toContain("network-verb");
    expect(drafts.find((d) => d.id === "err-checker")?.flags).toContain("checker-looks-like-error");
  });

  it("accept re-flags at accept time, stamps the reviewer, appends to the live corpus, and removes from pending", async () => {
    const result = await acceptDrafts(["good-1", "abs-path", "nope"], {
      reviewedBy: "victor",
      configDir: tmpDir,
    });
    expect(result.accepted).toEqual(["good-1"]);
    expect(result.refused.map((r) => r.id).toSorted()).toEqual(["abs-path", "nope"]);
    expect(result.refused.find((r) => r.id === "abs-path")?.reason).toContain("absolute-path");
    expect(result.liveTaskCount).toBe(1);
    const live = await loadTaskCorpus(opts());
    expect(live?.tasks.map((t) => t.id)).toEqual(["good-1"]);
    expect(live?.tasks[0]?.suite).toBe("capability");
    expect(live?.tasks[0]?.tags).toContain("reviewed");
    const raw = await fs.readFile(corpusPath(opts()), "utf-8");
    expect(raw).toContain('"reviewedBy":"victor"');
    const pending = await listPendingDrafts(opts());
    expect(pending.map((d) => d.id)).not.toContain("good-1");
    expect(pending.map((d) => d.id)).toContain("abs-path");
    // Accepting again refuses as already live.
    await fs.appendFile(pendingCorpusPath(opts()), draft("good-1", "dup", "3") + "\n");
    const again = await acceptDrafts(["good-1"], { reviewedBy: "victor", configDir: tmpDir });
    expect(again.refused[0]?.reason).toContain("already in the live corpus");
  });

  it("reject removes drafts, records them, and the miner exclusion set covers both outcomes", async () => {
    const r = await rejectDrafts(["network", "ghost"], {
      reviewedBy: "victor",
      reason: "dials out",
      configDir: tmpDir,
    });
    expect(r).toEqual({ rejected: ["network"], missing: ["ghost"] });
    const rejectedRaw = await fs.readFile(rejectedCorpusPath(opts()), "utf-8");
    expect(rejectedRaw).toContain('"id":"network"');
    expect(rejectedRaw).toContain('"reason":"dials out"');
    await acceptDrafts(["good-2"], { reviewedBy: "victor", configDir: tmpDir });
    const ids = await reviewedDraftIds(opts());
    expect([...ids].toSorted()).toEqual(["good-2", "network"]);
    expect((await listPendingDrafts(opts())).map((d) => d.id)).toEqual([
      "good-1",
      "abs-path",
      "err-checker",
    ]);
  });
});
