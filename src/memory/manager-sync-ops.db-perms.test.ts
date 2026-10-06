import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { restrictDbFilePermissions } from "./manager-sync-ops.js";

// Security pass M6: the memory DB holds circles sender keys and every memory
// chunk, so it must be owner-only like identity/box.json.
describe.runIf(process.platform !== "win32")("memory DB file permissions", () => {
  it("tightens the database and its WAL sidecars to 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-perms-"));
    const db = path.join(dir, "main.sqlite");
    for (const f of [db, `${db}-wal`, `${db}-shm`]) {
      fs.writeFileSync(f, "", { mode: 0o644 });
      fs.chmodSync(f, 0o644);
    }
    restrictDbFilePermissions(db);
    for (const f of [db, `${db}-wal`, `${db}-shm`]) {
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores missing sidecars", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-perms-"));
    const db = path.join(dir, "main.sqlite");
    fs.writeFileSync(db, "");
    expect(() => restrictDbFilePermissions(db)).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
