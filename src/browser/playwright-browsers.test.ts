import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeMissingPlaywrightBrowser,
  inspectPlaywrightBrowsers,
  looksLikeMissingPlaywrightBrowser,
  playwrightInstallCommand,
  readPlaywrightBrowserRevisions,
  resolvePlaywrightBrowsersDir,
  resolvePlaywrightCoreDir,
} from "./playwright-browsers.js";

const BROWSERS_JSON = JSON.stringify({
  browsers: [
    { name: "chromium", revision: "1243" },
    { name: "chromium-headless-shell", revision: "1243" },
    { name: "firefox", revision: "1543" },
  ],
});

const files: Record<string, string> = {
  "/pw/package.json": JSON.stringify({ version: "1.63.0" }),
  "/pw/browsers.json": BROWSERS_JSON,
};
const readFile = (p: string) => {
  const content = files[p.split(path.sep).join("/")];
  if (content === undefined) {
    throw new Error(`ENOENT ${p}`);
  }
  return content;
};

describe("playwright browser revisions", () => {
  it("reads the pinned Chromium revisions", () => {
    expect(readPlaywrightBrowserRevisions("/pw", { readFile })).toEqual({
      version: "1.63.0",
      chromium: "1243",
      headlessShell: "1243",
    });
    expect(readPlaywrightBrowserRevisions("/missing", { readFile })).toBeNull();
  });

  it("matches the installed playwright-core's real browsers.json", () => {
    const pwDir = resolvePlaywrightCoreDir();
    expect(pwDir).not.toBeNull();
    const revisions = readPlaywrightBrowserRevisions(pwDir as string);
    expect(revisions?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(revisions?.headlessShell).toMatch(/^\d+$/);
  });

  it("resolves Playwright's browsers directory per platform", () => {
    expect(resolvePlaywrightBrowsersDir({ env: {}, platform: "linux", homedir: "/h" })).toBe(
      path.join("/h", ".cache", "ms-playwright"),
    );
    expect(
      resolvePlaywrightBrowsersDir({
        env: { XDG_CACHE_HOME: "/x" },
        platform: "linux",
        homedir: "/h",
      }),
    ).toBe(path.join("/x", "ms-playwright"));
    expect(resolvePlaywrightBrowsersDir({ env: {}, platform: "darwin", homedir: "/h" })).toBe(
      path.join("/h", "Library", "Caches", "ms-playwright"),
    );
    expect(
      resolvePlaywrightBrowsersDir({
        env: { PLAYWRIGHT_BROWSERS_PATH: "/b" },
        platform: "linux",
        homedir: "/h",
      }),
    ).toBe(path.resolve("/b"));
    expect(
      resolvePlaywrightBrowsersDir({
        env: { PLAYWRIGHT_BROWSERS_PATH: "0" },
        platform: "linux",
        homedir: "/h",
        pwDir: "/pw",
      }),
    ).toBe(path.join("/pw", ".local-browsers"));
  });

  it("detects a stale revision (1208 cached, 1243 pinned)", () => {
    const root = path.join("/h", ".cache", "ms-playwright");
    const present = new Set([
      path.join(root, "chromium-1208"),
      path.join(root, "chromium_headless_shell-1208"),
    ]);
    const state = inspectPlaywrightBrowsers({
      pwDir: "/pw",
      env: {},
      platform: "linux",
      homedir: "/h",
      probe: {
        readFile,
        exists: (p) => present.has(p),
        listDir: () => ["chromium-1208", "chromium_headless_shell-1208", "ffmpeg-1011"],
      },
    });
    expect(state).toMatchObject({
      browsersDir: root,
      chromiumInstalled: false,
      headlessShellInstalled: false,
      installedRevisions: ["1208"],
    });
  });
});

describe("playwright install command", () => {
  it("uses pnpm in a source checkout", () => {
    expect(playwrightInstallCommand({ installKind: "git", pwDir: "/repo/node_modules/pc" })).toBe(
      "pnpm exec playwright-core install chromium",
    );
  });

  it("runs the bundled CLI with the running Node elsewhere", () => {
    expect(
      playwrightInstallCommand({
        installKind: "package",
        pwDir: "/usr/lib/node_modules/bitterbot/node_modules/playwright-core",
        env: {},
        platform: "linux",
        execPath: "/usr/bin/node",
      }),
    ).toBe(
      "/usr/bin/node /usr/lib/node_modules/bitterbot/node_modules/playwright-core/cli.js install chromium",
    );
  });

  it("targets ~/.bitterbot/browsers for a release-tarball install", () => {
    expect(
      playwrightInstallCommand({
        installKind: "tarball",
        pwDir: "/h/.bitterbot/app/1.5.0/node_modules/playwright-core",
        env: {},
        platform: "linux",
        homedir: "/h",
        execPath: "/h/.bitterbot/app/1.5.0/runtime/node/bin/node",
      }),
    ).toBe(
      "PLAYWRIGHT_BROWSERS_PATH=/h/.bitterbot/browsers /h/.bitterbot/app/1.5.0/runtime/node/bin/node /h/.bitterbot/app/1.5.0/node_modules/playwright-core/cli.js install chromium",
    );
  });

  it("quotes paths with spaces", () => {
    expect(
      playwrightInstallCommand({
        installKind: "package",
        pwDir: "/Users/a b/pc",
        env: {},
        platform: "darwin",
        execPath: "/usr/local/bin/node",
      }),
    ).toBe('/usr/local/bin/node "/Users/a b/pc/cli.js" install chromium');
  });
});

describe("missing-browser launch errors", () => {
  const raw =
    "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell\n" +
    "Looks like Playwright Test or Playwright was just installed or updated.\n" +
    "Please run the following command to download new browsers:\n    npx playwright install";

  it("recognises Playwright's missing-executable error and nothing else", () => {
    expect(looksLikeMissingPlaywrightBrowser(raw)).toBe(true);
    expect(looksLikeMissingPlaywrightBrowser("net::ERR_NAME_NOT_RESOLVED")).toBe(false);
  });

  it("replaces the stack with the build and the exact fix", () => {
    const message = describeMissingPlaywrightBrowser(
      "pnpm exec playwright-core install chromium",
      raw,
    );
    expect(message).toContain("chromium_headless_shell-1243");
    expect(message).toContain("`pnpm exec playwright-core install chromium`");
    expect(message).not.toContain("browserType.launch");
  });
});
