import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error Experimental JS fixtures have no declaration file.
import { createProvider, model } from "./provider.mjs";

vi.mock("dotenv", () => ({ default: { config: () => {} } }));
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function setup(ceiling = 10) {
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-not-a-real-key");
  const directory = mkdtempSync(join(tmpdir(), "strategy-provider-"));
  directories.push(directory);
  return { directory, provider: createProvider(directory, ceiling) };
}
function response() {
  return Response.json({
    model,
    usage: { input_tokens: 100, output_tokens: 20 },
    content: [{ type: "text", text: '{"action":"submit","index":1}' }],
    stop_reason: "end_turn",
  });
}
it("records the request intent before dispatch and settles actual usage", async () => {
  const { directory, provider } = setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const rows = readFileSync(join(directory, "provider.jsonl"), "utf8").trim().split("\n");
      expect(JSON.parse(rows[0]).type).toBe("intent");
      expect(rows).toHaveLength(1);
      return response();
    }),
  );
  const result = await provider.call("synthetic fixture");
  expect(result.usd).toBeCloseTo(0.0006);
  expect(provider.status()).toMatchObject({
    spent: result.usd,
    reserved: 0,
    unresolved: 0,
    active: 0,
  });
  expect(readFileSync(join(directory, "provider.jsonl"), "utf8")).not.toContain(
    "fixture-not-a-real-key",
  );
});
it("retains liability after an unpriced failure and blocks further collection", async () => {
  const { provider } = setup();
  const fetch = vi.fn(async () => {
    throw new Error("fixture network failure");
  });
  vi.stubGlobal("fetch", fetch);
  await expect(provider.call("one")).rejects.toThrow("network failure");
  expect(provider.status().reserved).toBeGreaterThan(0);
  expect(provider.status()).toMatchObject({ spent: 0, unresolved: 1, active: 0 });
  await expect(provider.call("two")).rejects.toThrow("Unresolved");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects unaffordable reservations before any request", async () => {
  const { provider } = setup(0.001);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(provider.call("fixture")).rejects.toThrow("ceiling");
  expect(fetch).not.toHaveBeenCalled();
  expect(provider.status()).toMatchObject({ spent: 0, reserved: 0, unresolved: 0, active: 0 });
});
it("hands queued requests the same three slots without exceeding concurrency", async () => {
  const { provider } = setup();
  let active = 0,
    peak = 0;
  const releases: Array<() => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return response();
    }),
  );
  const calls = Array.from({ length: 7 }, (_, index) => provider.call(`fixture-${index}`));
  await vi.waitFor(() => expect(releases).toHaveLength(3));
  while (releases.length < 7) {
    const previous = releases.length;
    for (const release of releases) release();
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(previous));
  }
  for (const release of releases) release();
  await Promise.all(calls);
  expect(peak).toBe(3);
  expect(provider.status().active).toBe(0);
  expect(provider.status().spent).toBeCloseTo(7 * 0.0006);
  expect(provider.status().reserved).toBeCloseTo(0);
});
