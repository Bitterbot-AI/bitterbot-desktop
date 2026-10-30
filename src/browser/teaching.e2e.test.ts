import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLive, resolveStorageRoots } from "../agents/skills/skill-storage.js";
import { createBrowserLiveView, type BrowserLiveView } from "./live-view.js";
import { resetBrowserControlForTest } from "./takeover.js";
import { describeTeachingInput } from "./teaching-capture.js";
import { defaultTeachingOptions } from "./teaching-draft.js";
import { stageTeachingSkill, activateTeachingSkill } from "./teaching-skills.js";
import { BrowserTeachingStore } from "./teaching-store.js";

// Opt in with BITTERBOT_TEACHING_BROWSER_TEST=1 after installing Playwright's
// Chromium. An existing compatible Chrome can be supplied with the path below.
describe.runIf(process.env.BITTERBOT_TEACHING_BROWSER_TEST === "1")("teaching in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let dir: string;
  let store: BrowserTeachingStore;
  let view: BrowserLiveView;
  const details = {
    title: "Find supplier invoices",
    goal: "Find an invoice for a supplier and month",
    outcome: "The result shows the requested supplier and month",
  };
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "teaching-browser-"));
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.BITTERBOT_TEACHING_CHROME_PATH,
    });
    page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.route("https://invoices.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `
      <label>Supplier<input id="supplier"></label>
      <label>Month<input id="month"></label>
      <button id="find">Find invoice</button><output id="result"></output>
      <label>Password<input id="password" type="password" autocomplete="current-password"></label>
      <select aria-label="Account"><option>Checking</option><option>Private account</option></select>
      <script>document.querySelector('#find').onclick = () => {
        document.querySelector('#result').textContent = document.querySelector('#supplier').value + ' / ' + document.querySelector('#month').value;
      };</script>`,
      }),
    );
    await page.goto("https://invoices.example/search?token=query-secret#private-fragment");
    store = new BrowserTeachingStore(dir);
    resetBrowserControlForTest();
    const cdp = await page.context().newCDPSession(page);
    view = createBrowserLiveView({
      teaching: store,
      resolve: async () => ({
        kind: "target",
        target: {
          profile: "bitterbot",
          targetId: "fixture",
          cdpUrl: "http://127.0.0.1",
          url: page.url(),
          title: "Invoices",
        },
      }),
      emit: () => {},
      startScreencast: async (opts) => {
        opts.onFrame({ data: "AAAA", deviceWidth: 1000, deviceHeight: 700 });
        return {
          stop: async () => {},
          describe: async () => ({ url: page.url(), title: "Invoices" }),
          describeInput: (command) => describeTeachingInput(page, command),
          input: async (command) => {
            await cdp.send(command.method, command.params);
          },
        };
      },
    });
    await view.start("owner");
    await view.control("owner", "user");
  }, 30_000);
  afterEach(async () => {
    await view?.shutdown();
    await browser?.close();
    resetBrowserControlForTest();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });
  async function click(selector: string) {
    const rect = await page.locator(selector).boundingBox();
    if (!rect) throw new Error("Fixture control not visible");
    for (const type of ["down", "up"]) {
      expect(
        await view.input("owner", {
          kind: "mouse",
          type,
          button: "left",
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        }),
      ).toEqual({ ok: true });
    }
  }
  it("captures the actual CDP input path and saves a parameterized, reusable skill", async () => {
    const recording = await store.start("owner", "bitterbot", details);
    expect((await view.input("other-window", { kind: "text", text: "not-authorized" })).ok).toBe(
      false,
    );
    await click("#supplier");
    await view.input("owner", { kind: "text", text: "Original confidential supplier" });
    await click("#month");
    await view.input("owner", { kind: "text", text: "2026-09" });
    await click("#find");
    await view.flushInput();
    const record = await store.stop("owner", recording.id);
    expect(await page.locator("output").textContent()).toBe(
      "Original confidential supplier / 2026-09",
    );
    expect(record.actions.filter((a) => a.kind === "type").map((a) => a.name)).toEqual([
      "Supplier",
      "Month",
    ]);
    const stored = await fs.readFile(path.join(dir, `${record.id}.json`), "utf8");
    for (const secret of [
      "confidential",
      "2026-09",
      "query-secret",
      "private-fragment",
      "not-authorized",
    ])
      expect(stored).not.toContain(secret);
    const roots = resolveStorageRoots({ configDir: dir });
    const options = {
      ...defaultTeachingOptions(record),
      parameters: { input_1: "supplier", input_2: "month" },
    };
    const staged = await stageTeachingSkill(record, options, roots);
    expect(staged.ok, staged.summary).toBe(true);
    await activateTeachingSkill(record, staged.hash!, roots);
    expect(await readLive(roots, options.name)).toContain("{{supplier}}");

    // Exercise the recorded semantic recipe with changed inputs and layout.
    // This verifies the recipe, not autonomous model performance.
    await page.locator("body").evaluate((body) => {
      body.style.padding = "150px 20px";
    });
    let input = 0;
    const values = ["Different supplier", "2026-10"];
    for (const action of record.actions) {
      const target = page.getByRole(action.role as Parameters<Page["getByRole"]>[0], {
        name: action.name,
        exact: true,
      });
      if (action.kind === "type") await target.fill(values[input++]);
      else if (action.kind === "click") await target.click();
    }
    expect(await page.locator("output").textContent()).toBe("Different supplier / 2026-10");
  });
  it("replaces credential and unsupported controls with handoff steps", async () => {
    const record = await store.start("owner", "bitterbot", details);
    await click("#password");
    await view.input("owner", { kind: "text", text: "password-never-retained" });
    await click("select");
    const stopped = await store.stop("owner", record.id);
    expect(stopped.actions[0].sensitive).toBe(true);
    expect(stopped.actions.at(-1)?.kind).toBe("manual");
    expect(JSON.stringify(stopped)).not.toContain("password-never-retained");
    expect(JSON.stringify(stopped)).not.toContain("Private account");
  });
  it("flushes pending input before stop and marks failed capture as unusable", async () => {
    const record = await store.start("owner", "bitterbot", details);
    await page.locator("#supplier").focus();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.append.bind(store);
    const append = vi.spyOn(store, "append").mockImplementation(async (...args) => {
      await blocked;
      return original(...args);
    });
    const pending = view.input("owner", { kind: "text", text: "Queued input" });
    await vi.waitFor(() => expect(append).toHaveBeenCalled());
    let flushed = false;
    const flushing = view.flushInput().then(() => {
      flushed = true;
    });
    expect(flushed).toBe(false);
    release();
    await pending;
    await flushing;
    expect((await store.stop("owner", record.id)).actions).toHaveLength(1);
    append.mockRestore();
    const next = await store.start("owner", "bitterbot", details);
    await page.unrouteAll();
    await page.goto("about:blank");
    await view.input("owner", { kind: "text", text: "unsupported page" });
    expect((await store.get(next.id)).status).toBe("failed");
  });
});
