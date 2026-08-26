import { describe, expect, it } from "vitest";
import { checkCheckoutFilesystem } from "./doctor-install.js";

// Measured basis (2026-08-24, reference WSL2 node): gateway boot 1757s with the
// checkout on /mnt/d (9p) vs 40.8s on ext4 — 43x. The warning exists so that
// number stops being invisible.
describe("doctor: checkout filesystem warning", () => {
  it("warns for Windows drive mounts seen from WSL", () => {
    for (const fsType of ["v9fs", "9p", "drvfs", "V9FS"]) {
      const w = checkCheckoutFilesystem("/mnt/d/Bitterbot/bitterbot-desktop", fsType);
      expect(w, fsType).toMatch(/Windows drive mount/);
      expect(w, fsType).toMatch(/Move the checkout/);
    }
  });

  it("stays silent on native filesystems", () => {
    for (const fsType of ["ext4", "ext2/ext3", "btrfs", "xfs", "zfs", "apfs"]) {
      expect(checkCheckoutFilesystem("/home/user/bitterbot-desktop", fsType), fsType).toBeNull();
    }
  });

  it("stays silent when the type cannot be determined", () => {
    expect(checkCheckoutFilesystem("/anywhere", null)).toBeNull();
  });
});
