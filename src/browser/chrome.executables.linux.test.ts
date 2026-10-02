import { describe, expect, it } from "vitest";
import { findPlaywrightChromiumLinux, isLaunchableLinuxBrowser } from "./chrome.executables.js";

/** A fake filesystem: which paths exist, and what the scripts among them say. */
function fsWith(paths: string[], scripts: Record<string, string> = {}) {
  const all = new Set([...paths, ...Object.keys(scripts)]);
  return {
    exists: (p: string) => all.has(p),
    readHead: (p: string) => scripts[p] ?? (all.has(p) ? "\x7fELF" : null),
  };
}

// What Ubuntu ships at /usr/bin/chromium-browser when chromium is a snap.
const SNAP_SHIM = `#!/bin/sh
if ! [ -x /snap/bin/chromium ]; then
    echo "Command '$0' requires the chromium snap to be installed." >&2
    exit 1
fi
exec /snap/bin/chromium "$@"
`;

describe("isLaunchableLinuxBrowser", () => {
  it("accepts a real binary", () => {
    expect(
      isLaunchableLinuxBrowser("/usr/bin/google-chrome", fsWith(["/usr/bin/google-chrome"])),
    ).toBe(true);
  });

  it("rejects a path that is not there", () => {
    expect(isLaunchableLinuxBrowser("/usr/bin/google-chrome", fsWith([]))).toBe(false);
  });

  it("rejects the chromium-browser shim when the snap behind it is not installed", () => {
    // The WSL case of 2026-10-02: the script and /snap/bin/chromium both exist,
    // nothing launches, and the gateway waited 15 s for a port that never opened.
    const io = fsWith(["/snap/bin/chromium"], { "/usr/bin/chromium-browser": SNAP_SHIM });

    expect(isLaunchableLinuxBrowser("/usr/bin/chromium-browser", io)).toBe(false);
    expect(isLaunchableLinuxBrowser("/snap/bin/chromium", io)).toBe(false);
  });

  it("rejects the shim when the snap is installed but not mounted", () => {
    // The real WSL state, found on the live box after the first version of this
    // check shipped: snapd is not running, /snap/chromium/current exists and
    // points at an empty revision directory, and the shim hangs when run.
    const io = fsWith(["/snap/bin/chromium", "/snap/chromium/current", "/snap/chromium/3396"], {
      "/usr/bin/chromium-browser": SNAP_SHIM,
    });

    expect(isLaunchableLinuxBrowser("/usr/bin/chromium-browser", io)).toBe(false);
    expect(isLaunchableLinuxBrowser("/snap/bin/chromium", io)).toBe(false);
  });

  it("accepts the same shim once the snap is mounted", () => {
    const io = fsWith(["/snap/bin/chromium", "/snap/chromium/current/meta/snap.yaml"], {
      "/usr/bin/chromium-browser": SNAP_SHIM,
    });

    expect(isLaunchableLinuxBrowser("/usr/bin/chromium-browser", io)).toBe(true);
    expect(isLaunchableLinuxBrowser("/snap/bin/chromium", io)).toBe(true);
  });

  it("accepts a wrapper script that does not go through snap", () => {
    const io = fsWith([], { "/usr/bin/brave-browser": '#!/bin/sh\nexec /opt/brave/brave "$@"\n' });

    expect(isLaunchableLinuxBrowser("/usr/bin/brave-browser", io)).toBe(true);
  });
});

describe("findPlaywrightChromiumLinux", () => {
  const home = () => "/home/someone";
  const root = "/home/someone/.cache/ms-playwright";
  const io = (dirs: string[], files: string[]) => ({
    exists: (p: string) => files.includes(p),
    listDir: (p: string) => (p === root || p === "/opt/pw" ? dirs : []),
  });

  it("finds the Chromium that playwright installed", () => {
    const exe = `${root}/chromium-1208/chrome-linux64/chrome`;

    expect(
      findPlaywrightChromiumLinux(io(["chromium-1208", "ffmpeg-1011"], [exe]), {}, home),
    ).toEqual({
      kind: "chromium",
      path: exe,
    });
  });

  it("prefers the newest revision, comparing numbers and not text", () => {
    const old = `${root}/chromium-999/chrome-linux64/chrome`;
    const current = `${root}/chromium-1208/chrome-linux64/chrome`;

    expect(
      findPlaywrightChromiumLinux(io(["chromium-999", "chromium-1208"], [old, current]), {}, home)
        ?.path,
    ).toBe(current);
  });

  it("falls back to an older revision whose binary is actually present", () => {
    const old = `${root}/chromium-1100/chrome-linux/chrome`;

    expect(
      findPlaywrightChromiumLinux(io(["chromium-1208", "chromium-1100"], [old]), {}, home)?.path,
    ).toBe(old);
  });

  it("ignores the headless shell and other downloads", () => {
    expect(
      findPlaywrightChromiumLinux(
        io(
          ["chromium_headless_shell-1208", "ffmpeg-1011"],
          [`${root}/chromium_headless_shell-1208/x`],
        ),
        {},
        home,
      ),
    ).toBeNull();
  });

  it("honours PLAYWRIGHT_BROWSERS_PATH", () => {
    const exe = "/opt/pw/chromium-1208/chrome-linux64/chrome";

    expect(
      findPlaywrightChromiumLinux(
        io(["chromium-1208"], [exe]),
        { PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" },
        home,
      )?.path,
    ).toBe(exe);
  });

  it("returns nothing when playwright has not installed a browser", () => {
    expect(findPlaywrightChromiumLinux(io([], []), {}, home)).toBeNull();
  });
});
