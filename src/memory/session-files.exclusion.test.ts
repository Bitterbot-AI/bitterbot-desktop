/**
 * PLAN-43 Phase 1 (R2): transcripts of inbound A2A task sessions (remote
 * callers) are excluded at the single chokepoint every transcript miner
 * shares — fact extraction, session indexing (hormones, preferences,
 * curiosity), handover briefs, KG ingestion. A remote caller's words must
 * never become node state.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let fixtureDir: string;

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: () => fixtureDir,
}));

import { listSessionFilesForAgent } from "./session-files.js";

describe("listSessionFilesForAgent — a2a-task exclusion", () => {
  beforeAll(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-session-files-"));
    await fs.writeFile(
      path.join(fixtureDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionId: "owner-1111" },
        "agent:main:a2a-task:9f0e": { sessionId: "remote-2222" },
        "agent:main:discord:group:g9": { sessionId: "group-3333" },
      }),
    );
    for (const id of [
      "owner-1111",
      "remote-2222",
      "group-3333",
      "unmapped-4444",
      // Self-describing id minted by the task executor: excluded by NAME
      // even though it has no sessions.json entry (survives store pruning).
      "a2a-5555",
    ]) {
      await fs.writeFile(path.join(fixtureDir, `${id}.jsonl`), "");
    }
  });

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it("drops remote-task transcripts, keeps everything else (incl. other untrusted classes)", async () => {
    const files = (await listSessionFilesForAgent("main")).map((p) => path.basename(p)).toSorted();
    expect(files).toEqual(["group-3333.jsonl", "owner-1111.jsonl", "unmapped-4444.jsonl"]);
  });

  it("keeps the name-shape filter even when sessions.json is unreadable", async () => {
    await fs.rm(path.join(fixtureDir, "sessions.json"));
    const files = (await listSessionFilesForAgent("main")).map((p) => path.basename(p));
    // Store-mapped exclusion is unavailable (remote-2222 reappears), but the
    // "a2a-" filename backstop still holds.
    expect(files).toHaveLength(4);
    expect(files).not.toContain("a2a-5555.jsonl");
    // restore for other tests
    await fs.writeFile(
      path.join(fixtureDir, "sessions.json"),
      JSON.stringify({ "agent:main:a2a-task:9f0e": { sessionId: "remote-2222" } }),
    );
  });
});
