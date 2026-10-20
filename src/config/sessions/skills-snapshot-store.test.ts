import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSkillsSnapshotBodyCacheForTest,
  externalizeSkillsSnapshots,
  materializeSessionSkillsSnapshot,
  pruneSkillsSnapshotFiles,
  SKILLS_SNAPSHOT_DIR,
  snapshotRefFor,
} from "./skills-snapshot-store.js";
import { clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } from "./store.js";
import {
  isSessionSkillSnapshotRef,
  type SessionEntry,
  type SessionSkillSnapshot,
} from "./types.js";

const prompt = "## Skills\n\n".padEnd(9_000, "x");
const snapshot: SessionSkillSnapshot = {
  prompt,
  skills: [{ name: "a" }, { name: "b", primaryEnv: "node" }],
  skillFilter: ["a", "b"],
  resolvedSkills: [{ name: "a", description: "A" } as never],
  version: 3,
};

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-skills-snap-"));
  storePath = path.join(dir, "sessions.json");
  clearSessionStoreCacheForTest();
  clearSkillsSnapshotBodyCacheForTest();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("skills snapshot externalization", () => {
  it("writes one body per distinct content and leaves refs in the entries", () => {
    const store: Record<string, SessionEntry> = {};
    for (let i = 0; i < 40; i++) {
      store[`agent:a:s${i}`] = { sessionId: `id-${i}`, updatedAt: i, skillsSnapshot: snapshot };
    }
    store["agent:a:other"] = {
      sessionId: "id-o",
      updatedAt: 1,
      skillsSnapshot: { ...snapshot, prompt: "different" },
    };
    store["agent:a:none"] = { sessionId: "id-n", updatedAt: 1 };

    const out = externalizeSkillsSnapshots(storePath, store);
    expect(out).not.toBe(store);
    // Input untouched.
    expect(isSessionSkillSnapshotRef(store["agent:a:s0"]!.skillsSnapshot)).toBe(false);
    const files = fs.readdirSync(path.join(dir, SKILLS_SNAPSHOT_DIR));
    expect(files).toHaveLength(2);
    const ref = out["agent:a:s0"]!.skillsSnapshot;
    expect(isSessionSkillSnapshotRef(ref)).toBe(true);
    if (!isSessionSkillSnapshotRef(ref)) {
      throw new Error("expected a ref");
    }
    expect(ref).toEqual({
      ref: snapshotRefFor(snapshot),
      skills: snapshot.skills,
      skillFilter: snapshot.skillFilter,
      version: 3,
    });
    expect(out["agent:a:none"]!.skillsSnapshot).toBeUndefined();
    // The index shrank by the body size times the entry count.
    const before = JSON.stringify(store).length;
    const after = JSON.stringify(out).length;
    expect(after).toBeLessThan(before / 20);
  });

  it("materializes a ref back into the full snapshot, and inline snapshots pass through", () => {
    const out = externalizeSkillsSnapshots(storePath, {
      "agent:a:s": { sessionId: "id", updatedAt: 1, skillsSnapshot: snapshot },
    });
    clearSkillsSnapshotBodyCacheForTest(); // force the file read
    const full = materializeSessionSkillsSnapshot(storePath, out["agent:a:s"]!.skillsSnapshot);
    expect(full).toEqual(snapshot);
    expect(materializeSessionSkillsSnapshot(storePath, snapshot)).toBe(snapshot);
    expect(materializeSessionSkillsSnapshot(storePath, undefined)).toBeUndefined();
  });

  it("returns undefined for a ref whose body is missing or unsafe", () => {
    expect(
      materializeSessionSkillsSnapshot(storePath, { ref: "0123456789abcdef", skills: [] }),
    ).toBeUndefined();
    expect(
      materializeSessionSkillsSnapshot(storePath, { ref: "../../etc/passwd", skills: [] }),
    ).toBeUndefined();
    expect(
      materializeSessionSkillsSnapshot(undefined, { ref: "0123456789abcdef", skills: [] }),
    ).toBeUndefined();
  });

  it("prunes bodies no entry references", () => {
    const out = externalizeSkillsSnapshots(storePath, {
      "agent:a:s": { sessionId: "id", updatedAt: 1, skillsSnapshot: snapshot },
      "agent:a:t": {
        sessionId: "id2",
        updatedAt: 1,
        skillsSnapshot: { ...snapshot, prompt: "gone soon" },
      },
    });
    expect(fs.readdirSync(path.join(dir, SKILLS_SNAPSHOT_DIR))).toHaveLength(2);
    delete out["agent:a:t"];
    expect(pruneSkillsSnapshotFiles(storePath, out)).toBe(1);
    expect(fs.readdirSync(path.join(dir, SKILLS_SNAPSHOT_DIR))).toEqual([
      `${snapshotRefFor(snapshot)}.json`,
    ]);
  });

  it("round-trips through saveSessionStore and loadSessionStore; a legacy inline index still loads", async () => {
    await saveSessionStore(storePath, {
      "agent:a:s": { sessionId: "id", updatedAt: 1, skillsSnapshot: snapshot },
    });
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
    expect(isSessionSkillSnapshotRef(onDisk["agent:a:s"]!.skillsSnapshot)).toBe(true);
    expect(fs.readFileSync(storePath, "utf-8")).not.toContain("xxxxxxxx");
    const loaded = loadSessionStore(storePath);
    expect(
      materializeSessionSkillsSnapshot(storePath, loaded["agent:a:s"]!.skillsSnapshot),
    ).toEqual(snapshot);

    // An index written before refs existed: inline body, no side files.
    const legacyPath = path.join(dir, "legacy", "sessions.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        "agent:a:old": { sessionId: "old", updatedAt: 1, skillsSnapshot: snapshot },
      }),
    );
    const legacy = loadSessionStore(legacyPath);
    expect(
      materializeSessionSkillsSnapshot(legacyPath, legacy["agent:a:old"]!.skillsSnapshot),
    ).toEqual(snapshot);
  });
});
