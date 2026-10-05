import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MonitorEngine, type MonitorEvent } from "./engine.js";
import { evaluate, extractValue, visibleText } from "./extract.js";
import { buildMonitor, patchMonitor } from "./store.js";

describe("extracting the watched value", () => {
  it("reads a page as its visible text", () => {
    const html =
      "<html><head><style>p{}</style><script>var x=1</script></head><body><h1>Widget</h1>\n<p>In&nbsp;stock &amp; ready</p><!-- note --></body></html>";
    expect(visibleText(html)).toBe("Widget In stock & ready");
  });

  it("reads a field of a JSON body", () => {
    const body = JSON.stringify({ data: { price: 19.5, items: [{ status: "open" }] } });
    expect(extractValue(body, { kind: "json", path: "data.price" })).toBe("19.5");
    expect(extractValue(body, { kind: "json", path: "data.items[0].status" })).toBe("open");
    expect(() => extractValue(body, { kind: "json", path: "data.missing" })).toThrow(/nothing at/);
    expect(() => extractValue("<html>", { kind: "json", path: "a" })).toThrow(/not JSON/);
  });

  it("reads a pattern match, or its capture", () => {
    expect(
      extractValue("Version: v2.4.1 (stable)", {
        kind: "regex",
        pattern: "v(\\d+\\.\\d+\\.\\d+)",
        group: 1,
      }),
    ).toBe("2.4.1");
    expect(() => extractValue("nothing here", { kind: "regex", pattern: "v\\d+" })).toThrow(
      /did not match/,
    );
  });
});

describe("deciding whether to fire", () => {
  it("changed: never on the first value, then on each difference", () => {
    const first = evaluate({ kind: "changed" }, { consecutiveErrors: 0 }, "v1");
    expect(first.fired).toBe(false);
    const same = evaluate({ kind: "changed" }, { consecutiveErrors: 0, ...first.health }, "v1");
    expect(same.fired).toBe(false);
    const diff = evaluate({ kind: "changed" }, { consecutiveErrors: 0, ...first.health }, "v2");
    expect(diff).toMatchObject({
      fired: true,
      changed: true,
      summary: 'changed from "v1" to "v2"',
    });
  });

  it("contains: fires when it starts to hold, including at first sight, and not again while it holds", () => {
    const cond = { kind: "contains", text: "in stock" } as const;
    const first = evaluate(cond, { consecutiveErrors: 0 }, "Widget: In Stock");
    expect(first).toMatchObject({ fired: true, summary: 'now contains "in stock"' });
    const still = evaluate(
      cond,
      { consecutiveErrors: 0, ...first.health },
      "Widget: In Stock (3 left)",
    );
    expect(still.fired).toBe(false);
    const gone = evaluate(cond, { consecutiveErrors: 0, ...still.health }, "Widget: Sold out");
    expect(gone.fired).toBe(false);
    const back = evaluate(cond, { consecutiveErrors: 0, ...gone.health }, "Widget: in stock");
    expect(back.fired).toBe(true);
  });

  it("thresholds read the number out of the value", () => {
    const below = { kind: "below", value: 100 } as const;
    expect(evaluate(below, { consecutiveErrors: 0 }, "$1,249.00").fired).toBe(false);
    expect(evaluate(below, { consecutiveErrors: 0, conditionMet: false }, "$89.99")).toMatchObject({
      fired: true,
      summary: "is below 100 (now $89.99)",
    });
    expect(evaluate({ kind: "above", value: 5 }, { consecutiveErrors: 0 }, "no number").fired).toBe(
      false,
    );
  });
});

describe("building a monitor", () => {
  it("fills in defaults and raises a too-short interval to the floor", () => {
    const m = buildMonitor({ url: "https://shop.test/widget", intervalMinutes: 0.1 }, 1_000);
    expect(m).toMatchObject({
      name: "shop.test",
      extract: { kind: "text" },
      condition: { kind: "changed" },
      intervalMs: 60_000,
      enabled: true,
      health: { consecutiveErrors: 0 },
    });
  });

  it("refuses what it cannot watch", () => {
    expect(() => buildMonitor({ url: "file:///etc/passwd" })).toThrow(/http/);
    expect(() => buildMonitor({ url: "not a url" })).toThrow(/full http/);
    expect(() =>
      buildMonitor({ url: "https://a.test", extract: { kind: "regex", pattern: "(" } }),
    ).toThrow(/valid/);
    expect(() => buildMonitor({ url: "https://a.test", condition: { kind: "above" } })).toThrow(
      /number/,
    );
  });

  it("forgets what it saw when it is pointed at something else", () => {
    const m = buildMonitor({ url: "https://a.test" }, 1);
    m.health = { consecutiveErrors: 2, lastValue: "old", lastValueHash: "h", lastError: "x" };
    expect(patchMonitor(m, { url: "https://b.test" }, 2).health).toEqual({ consecutiveErrors: 0 });
    expect(patchMonitor(m, { name: "Renamed" }, 2).health.lastValue).toBe("old");
  });
});

describe("MonitorEngine", () => {
  let now: number;
  let body: string | Error;
  let events: MonitorEvent[];
  let fetches: number;
  let storePath: string;
  const make = () =>
    new MonitorEngine({
      storePath,
      nowMs: () => now,
      tickMs: 10_000_000,
      fetchBody: async () => {
        fetches += 1;
        if (body instanceof Error) throw body;
        return body;
      },
      onEvent: (e) => events.push(e),
    });

  beforeEach(async () => {
    now = 1_000_000;
    body = "price: 120";
    events = [];
    fetches = 0;
    storePath = path.join(
      await mkdtemp(path.join(tmpdir(), "bitterbot-monitors-")),
      "monitors.json",
    );
  });

  it("checks when due, fires on a change, and keeps its state across a restart", async () => {
    const engine = make();
    await engine.start();
    const m = await engine.add({ name: "Price", url: "https://shop.test/p", intervalMinutes: 5 });

    await engine.tick();
    expect(fetches).toBe(1);
    expect(events.filter((e) => e.kind === "fired")).toHaveLength(0);

    // Not due yet: nothing is fetched.
    now += 60_000;
    await engine.tick();
    expect(fetches).toBe(1);

    now += 5 * 60_000;
    body = "price: 95";
    await engine.tick();
    expect(events.find((e) => e.kind === "fired")).toMatchObject({
      summary: 'changed from "price: 120" to "price: 95"',
    });
    await engine.stop();

    const second = make();
    await second.start();
    expect(second.get(m.id)?.health).toMatchObject({ lastValue: "price: 95", lastChangeAt: now });
    await second.stop();
  });

  it("says once that a monitor cannot be checked, slows down, and recovers", async () => {
    const engine = make();
    await engine.start();
    const m = await engine.add({ url: "https://shop.test/p", intervalMinutes: 1 });
    body = new Error("the server answered 503");

    for (let i = 0; i < 5; i += 1) {
      await engine.check(m.id);
    }
    expect(events.filter((e) => e.kind === "failing")).toHaveLength(1);
    const failing = engine.get(m.id);
    expect(failing?.health).toMatchObject({
      consecutiveErrors: 5,
      lastError: "the server answered 503",
    });
    // Five failures: checked at 8 times the interval, not every minute.
    expect(engine.nextCheckAt(failing!)).toBe(now + 8 * 60_000);

    body = "back";
    await engine.check(m.id);
    expect(engine.get(m.id)?.health).toMatchObject({ consecutiveErrors: 0, lastError: undefined });
    await engine.stop();
  });

  it("leaves a disabled monitor alone and caps how many there are", async () => {
    const engine = make();
    await engine.start();
    const m = await engine.add({ url: "https://shop.test/p", enabled: false });
    await engine.tick();
    expect(fetches).toBe(0);
    expect(await engine.remove(m.id)).toBe(true);
    for (let i = 0; i < 50; i += 1) {
      await engine.add({ url: `https://shop.test/${i}`, enabled: false });
    }
    await expect(engine.add({ url: "https://shop.test/x" })).rejects.toThrow(/already 50/);
    await engine.stop();
  });
});
