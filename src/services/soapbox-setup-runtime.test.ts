import { mkdtemp, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  SOAPBOX_SETUP_RELEASE,
  SoapboxSetupRuntime,
  prepareSoapboxGpuLock,
} from "./soapbox-setup-runtime.js";

it("allows the runtime to acquire its lock on a fresh operator profile without a wallet", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "soapbox-fresh-operator-"));
  try {
    const lock = await prepareSoapboxGpuLock(home);
    const file = await open(lock, "wx", 0o600);
    await file.close();
    expect(await prepareSoapboxGpuLock(home)).toBe(lock);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "rejects out-of-order and oversized chunks and never executes a modified archive",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soapbox-upload-test-"));
    const run = vi.fn();
    const runtime = new SoapboxSetupRuntime(directory, run);
    try {
      const { id } = await runtime.begin();
      await expect(runtime.chunk(id, 1, "YQ==")).rejects.toThrow("chunk");
      await expect(runtime.chunk(id, 0, Buffer.alloc(262145).toString("base64"))).rejects.toThrow(
        "size",
      );
      await expect(runtime.chunk("different-id", 0, "YQ==")).rejects.toThrow("expired");
      await expect(runtime.prepare(id)).rejects.toThrow("Complete");
      for (let offset = 0; offset < SOAPBOX_SETUP_RELEASE.bytes; ) {
        const bytes = Buffer.alloc(Math.min(262144, SOAPBOX_SETUP_RELEASE.bytes - offset));
        offset = (await runtime.chunk(id, offset, bytes.toString("base64"))).offset;
      }
      await expect(runtime.prepare(id)).rejects.toThrow("checksum");
      expect(run).not.toHaveBeenCalled();
      expect(runtime.progress.state).toBe("failed");
    } finally {
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
