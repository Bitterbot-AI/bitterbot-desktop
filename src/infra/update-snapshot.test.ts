import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "./tarball-install.js";
import {
  createUpdateSnapshot,
  listSnapshots,
  pruneSnapshots,
  SnapshotError,
  snapshotsRoot,
  type SnapshotSources,
} from "./update-snapshot.js";

describe("pre-update snapshots", () => {
  let stateDir: string;
  let sources: SnapshotSources;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-snapshot-"));
    fs.writeFileSync(path.join(stateDir, "bitterbot.json"), "{}\n");
    fs.mkdirSync(path.join(stateDir, "memory"));
    sources = {
      stateDir,
      configPath: path.join(stateDir, "bitterbot.json"),
      workspaceDir: null,
      keyDir: null,
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("copies a live WAL database consistently (writes still in the -wal file are included)", async () => {
    const file = path.join(stateDir, "memory", "main.sqlite");
    const live = new DatabaseSync(file);
    try {
      live.exec("PRAGMA journal_mode = WAL");
      live.exec("PRAGMA wal_autocheckpoint = 0");
      live.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
      live.exec("INSERT INTO meta VALUES ('schema_version', '77')");
      live.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY, text TEXT)");
      for (let i = 0; i < 50; i += 1) {
        live.prepare("INSERT INTO chunks (text) VALUES (?)").run(`m${i}`);
      }
      expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
      const { dir, manifest } = await createUpdateSnapshot({
        sources,
        from: "1.4.0",
        to: "1.5.0",
        fromMemorySchemaLatest: 77,
      });
      expect(manifest.entries.find((e) => e.kind === "database")?.schemaVersion).toBe(77);
      const copy = new DatabaseSync(path.join(dir, "memory", "main.sqlite"), { readOnly: true });
      try {
        expect((copy.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n).toBe(
          50,
        );
      } finally {
        copy.close();
      }
      expect(fs.existsSync(path.join(dir, "memory", "main.sqlite-wal"))).toBe(false);
    } finally {
      live.close();
    }
  });

  it("never reads a whole database copy into memory to hash it", async () => {
    const file = path.join(stateDir, "memory", "main.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    db.close();
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const { manifest } = await createUpdateSnapshot({
      sources,
      from: "1.4.0",
      to: "1.5.0",
      fromMemorySchemaLatest: 1,
    });
    expect(manifest.entries.find((e) => e.kind === "database")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Only the small manifest may be read whole; never a snapshot file.
    const whole = readFileSync.mock.calls
      .map((c) => String(c[0]))
      .filter((f) => !f.endsWith("manifest.json"));
    expect(whole).toEqual([]);
  });

  it("hashes a file larger than 2 GiB (a Buffer cannot hold it)", async () => {
    const big = path.join(stateDir, "sparse.bin");
    // Sparse: no disk blocks are written, but the size is past the
    // ERR_FS_FILE_TOO_LARGE limit of fs.readFileSync.
    const fd = fs.openSync(big, "w");
    fs.ftruncateSync(fd, 2 ** 31 + 1);
    fs.closeSync(fd);
    try {
      expect(() => fs.readFileSync(big)).toThrow();
      expect(await sha256File(big)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(big, { force: true });
    }
  }, 120_000);

  it("refuses (and leaves nothing behind) when the disk is too full", async () => {
    fs.writeFileSync(path.join(stateDir, "memory", "main.sqlite"), Buffer.alloc(1024));
    vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: 1, bsize: 1 } as fs.StatsFs);
    await expect(
      createUpdateSnapshot({ sources, from: "1.4.0", to: "1.5.0", fromMemorySchemaLatest: 1 }),
    ).rejects.toThrow(SnapshotError);
    expect(fs.readdirSync(snapshotsRoot(stateDir))).toEqual([]);
  });

  it("a database that cannot be copied fails the snapshot", async () => {
    fs.writeFileSync(path.join(stateDir, "memory", "main.sqlite"), "not a database at all, really");
    await expect(
      createUpdateSnapshot({ sources, from: "1.4.0", to: "1.5.0", fromMemorySchemaLatest: 1 }),
    ).rejects.toThrow(/VACUUM INTO/);
    expect(fs.readdirSync(snapshotsRoot(stateDir))).toEqual([]);
  });

  it("prunes beyond the newest N complete snapshots and incomplete ones, nothing else", async () => {
    const root = snapshotsRoot(stateDir);
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, "20260101T000000Z-1.0.0-to-1.1.0"));
    fs.mkdirSync(path.join(root, "my-notes"));
    for (const [i, to] of ["1.2.0", "1.3.0", "1.4.0", "1.5.0"].entries()) {
      await createUpdateSnapshot({
        sources,
        from: "1.1.0",
        to,
        fromMemorySchemaLatest: 1,
        now: new Date(Date.UTC(2026, 1, 1 + i)),
      });
    }
    expect(listSnapshots(stateDir).map((s) => s.manifest.to)).toEqual(["1.5.0", "1.4.0", "1.3.0"]);
    expect(fs.existsSync(path.join(root, "20260101T000000Z-1.0.0-to-1.1.0"))).toBe(false);
    expect(fs.existsSync(path.join(root, "my-notes"))).toBe(true);
    expect(pruneSnapshots(stateDir, 1)).toHaveLength(2);
  });
});
