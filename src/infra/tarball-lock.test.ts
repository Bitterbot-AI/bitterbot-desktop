/**
 * Leftover cleanup under the app-dir lock: staging dirs and temporary swap
 * links of interrupted processes go, a live process's temp link stays.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeUpdateLeftovers } from "./tarball-lock.js";

describe.skipIf(process.platform === "win32")("removeUpdateLeftovers", () => {
  it("removes staging dirs and dead processes' .current/.previous temp links", () => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-leftovers-"));
    try {
      // A pid that has certainly exited.
      const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
      fs.mkdirSync(path.join(appDir, ".update-abc"));
      fs.symlinkSync("1.6.2", path.join(appDir, `.current.${dead}.m1x2y3`));
      fs.symlinkSync("1.6.1", path.join(appDir, `.previous.${dead}.k9`));
      fs.symlinkSync("1.6.2", path.join(appDir, `.current.${process.pid}.live1`));
      fs.symlinkSync("1.6.2", path.join(appDir, "current"));
      removeUpdateLeftovers(appDir, null);
      expect(fs.readdirSync(appDir).toSorted()).toEqual([
        `.current.${process.pid}.live1`,
        "current",
      ]);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});
