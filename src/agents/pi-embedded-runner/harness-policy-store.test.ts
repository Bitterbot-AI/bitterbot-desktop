import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadActiveHarnessPolicy,
  promotePolicy,
  readLivePolicy,
  readPolicyHistory,
  rollbackPolicy,
} from "./harness-policy-store.js";
import { defaultHarnessPolicy, type HarnessPolicy } from "./harness-policy.js";

function candidate(fragmentText: string): HarnessPolicy {
  const p = defaultHarnessPolicy();
  p.prompt.fragments.push({ id: "f1", text: fragmentText, order: 0 });
  return p;
}

describe("harness-policy-store (PLAN-25)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "harness-policy-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadActiveHarnessPolicy returns baseline when nothing is promoted", () => {
    const active = loadActiveHarnessPolicy(undefined, { configDir: dir });
    expect(active.provenance).toBe("default");
    expect(active.prompt.fragments).toEqual([]);
    expect(readLivePolicy({ configDir: dir })).toBeNull();
  });

  it("promote writes live, sets provenance=evolved, and is readable", async () => {
    const res = await promotePolicy(candidate("alpha"), { reason: "test" }, { configDir: dir });
    expect(res.version).toBeGreaterThan(0);
    const live = readLivePolicy({ configDir: dir });
    expect(live?.provenance).toBe("evolved");
    expect(live?.prompt.fragments[0]?.text).toBe("alpha");
    const active = loadActiveHarnessPolicy(undefined, { configDir: dir });
    expect(active.prompt.fragments[0]?.text).toBe("alpha");
  });

  it("promoting again archives the prior version and increments", async () => {
    const first = await promotePolicy(candidate("alpha"), { reason: "v1" }, { configDir: dir });
    const second = await promotePolicy(candidate("beta"), { reason: "v2" }, { configDir: dir });
    expect(second.version).toBeGreaterThan(first.version);
    expect(second.previousVersion).toBe(first.version);
    const history = await readPolicyHistory(5, { configDir: dir });
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].policy.prompt.fragments[0]?.text).toBe("alpha");
  });

  it("rollback restores an archived version", async () => {
    const first = await promotePolicy(candidate("alpha"), { reason: "v1" }, { configDir: dir });
    await promotePolicy(candidate("beta"), { reason: "v2" }, { configDir: dir });
    expect(readLivePolicy({ configDir: dir })?.prompt.fragments[0]?.text).toBe("beta");
    const restored = await rollbackPolicy(first.version, "regression", { configDir: dir });
    expect(restored?.prompt.fragments[0]?.text).toBe("alpha");
    expect(readLivePolicy({ configDir: dir })?.prompt.fragments[0]?.text).toBe("alpha");
  });

  it("rollback to a missing version is a safe no-op", async () => {
    expect(await rollbackPolicy(999, "nope", { configDir: dir })).toBeNull();
  });
});
