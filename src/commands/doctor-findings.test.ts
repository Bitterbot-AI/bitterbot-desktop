import { describe, expect, it } from "vitest";
import { collectRepairFindings, resetRepairFindingsCache } from "./doctor-findings.js";

describe("collectRepairFindings (PLAN-41 Repairs card)", () => {
  it("returns structured findings incl. the Control UI section (plan39-r1)", async () => {
    resetRepairFindingsCache();
    const report = await collectRepairFindings({ force: true });
    expect(report.findings.length).toBeGreaterThan(0);
    expect(["ok", "info", "warn", "error"]).toContain(report.worstLevel);
    for (const f of report.findings) {
      expect(typeof f.section).toBe("string");
      expect(typeof f.message).toBe("string");
    }
    const sections = new Set(report.findings.map((f) => f.section));
    expect(sections.has("Control UI")).toBe(true);
  });

  it("caches within the TTL and refreshes with force", async () => {
    resetRepairFindingsCache();
    const a = await collectRepairFindings({ now: 1000 });
    const b = await collectRepairFindings({ now: 2000 });
    expect(b).toBe(a);
    const c = await collectRepairFindings({ now: 2000, force: true });
    expect(c).not.toBe(a);
  });
});
