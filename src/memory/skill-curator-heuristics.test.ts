import { describe, expect, it } from "vitest";
import type { SkillLifecycleRow } from "./skill-lifecycle.js";
import {
  classifyTransition,
  DEFAULT_THRESHOLDS,
  formatReportMarkdown,
  runHeuristicPass,
} from "./skill-curator-heuristics.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function row(partial: Partial<SkillLifecycleRow> = {}): SkillLifecycleRow {
  return {
    skillName: partial.skillName ?? "test-skill",
    origin: partial.origin ?? "agent_authored",
    state: partial.state ?? "active",
    createdAt: partial.createdAt ?? NOW - 30 * DAY,
    lastUsedAt: partial.lastUsedAt ?? NOW - DAY,
    usageCount: partial.usageCount ?? 10,
    successCount: partial.successCount ?? 10,
    errorCount: partial.errorCount ?? 0,
    consolidatedInto: partial.consolidatedInto ?? null,
    pinned: partial.pinned ?? false,
    updatedAt: partial.updatedAt ?? NOW,
  };
}

describe("classifyTransition — guard clauses", () => {
  it("returns noop for pinned skills regardless of state", () => {
    const result = classifyTransition(row({ pinned: true, lastUsedAt: NOW - 500 * DAY }), NOW);
    expect(result.kind).toBe("noop");
    expect(result.toState).toBeNull();
    expect(result.reason).toContain("pinned");
  });

  it("returns noop for non-agent_authored origins", () => {
    for (const origin of ["managed", "workspace", "p2p", "unknown"] as const) {
      const result = classifyTransition(row({ origin, lastUsedAt: NOW - 500 * DAY }), NOW);
      expect(result.kind).toBe("noop");
      expect(result.reason).toContain(origin);
    }
  });
});

describe("classifyTransition — active → stale", () => {
  it("stays active during the fresh-skill grace window", () => {
    const result = classifyTransition(
      row({
        createdAt: NOW - 1 * DAY,
        usageCount: 0,
        lastUsedAt: null,
      }),
      NOW,
    );
    expect(result.kind).toBe("noop");
    expect(result.reason).toContain("fresh-skill grace");
  });

  it("transitions to stale when unused past the unused-age threshold", () => {
    const result = classifyTransition(
      row({
        createdAt: NOW - 20 * DAY,
        usageCount: 0,
        lastUsedAt: null,
      }),
      NOW,
    );
    expect(result.kind).toBe("stale");
    expect(result.toState).toBe("stale");
    expect(result.reason).toContain("unused");
  });

  it("transitions to stale when last-used exceeds the idle threshold", () => {
    const result = classifyTransition(
      row({
        createdAt: NOW - 200 * DAY,
        usageCount: 50,
        lastUsedAt: NOW - 90 * DAY,
      }),
      NOW,
    );
    expect(result.kind).toBe("stale");
    expect(result.reason).toContain("idle");
  });

  it("stays active when recently used", () => {
    const result = classifyTransition(
      row({
        createdAt: NOW - 200 * DAY,
        usageCount: 50,
        lastUsedAt: NOW - 5 * DAY,
      }),
      NOW,
    );
    expect(result.kind).toBe("noop");
  });
});

describe("classifyTransition — stale → archived", () => {
  it("archives stale skills past the archive threshold", () => {
    const result = classifyTransition(
      row({
        state: "stale",
        lastUsedAt: NOW - 150 * DAY,
      }),
      NOW,
    );
    expect(result.kind).toBe("archived");
    expect(result.toState).toBe("archived");
  });

  it("leaves stale skills below threshold untouched", () => {
    const result = classifyTransition(
      row({
        state: "stale",
        lastUsedAt: NOW - 80 * DAY,
      }),
      NOW,
    );
    expect(result.kind).toBe("noop");
  });
});

describe("classifyTransition — archived → reactivate", () => {
  it("reactivates an archived skill used within the grace window", () => {
    const result = classifyTransition(
      row({
        state: "archived",
        lastUsedAt: NOW - 2 * DAY,
      }),
      NOW,
    );
    expect(result.kind).toBe("reactivate");
    expect(result.toState).toBe("active");
  });

  it("leaves long-idle archived skills archived", () => {
    const result = classifyTransition(
      row({
        state: "archived",
        lastUsedAt: NOW - 200 * DAY,
      }),
      NOW,
    );
    expect(result.kind).toBe("noop");
    expect(result.reason).toBe("already archived");
  });
});

describe("classifyTransition — error-rate flagging", () => {
  it("flags skills with error rate above threshold", () => {
    const result = classifyTransition(
      row({
        usageCount: 20,
        successCount: 8,
        errorCount: 12,
        lastUsedAt: NOW - 1 * DAY,
      }),
      NOW,
    );
    expect(result.kind).toBe("flag-for-llm");
    expect(result.toState).toBeNull();
    expect(result.reason).toContain("error rate");
  });

  it("ignores high error rate below the minimum-executions floor", () => {
    const result = classifyTransition(
      row({
        usageCount: 3,
        successCount: 0,
        errorCount: 3,
        lastUsedAt: NOW - 1 * DAY,
      }),
      NOW,
    );
    expect(result.kind).toBe("noop");
  });

  it("does NOT auto-archive even severely high error rates — only the LLM does", () => {
    const result = classifyTransition(
      row({
        usageCount: 100,
        successCount: 5,
        errorCount: 95,
        lastUsedAt: NOW - 1 * DAY,
      }),
      NOW,
    );
    expect(result.kind).toBe("flag-for-llm");
    expect(result.toState).toBeNull();
  });

  it("staleness wins over error-rate flagging when both apply", () => {
    // When a skill is idle long enough to be stale-flagged, we transition
    // first; the LLM-judge pass picks up the staled row and decides whether
    // to archive given the error history.
    const result = classifyTransition(
      row({
        state: "active",
        usageCount: 20,
        errorCount: 15,
        lastUsedAt: NOW - 100 * DAY,
      }),
      NOW,
    );
    expect(result.kind).toBe("stale");
  });
});

describe("runHeuristicPass", () => {
  it("aggregates proposals into transitions / borderlines / noops", () => {
    const report = runHeuristicPass({
      candidates: [
        row({
          skillName: "stale-by-age",
          usageCount: 0,
          createdAt: NOW - 20 * DAY,
          lastUsedAt: null,
        }),
        row({ skillName: "high-error", usageCount: 20, errorCount: 15, lastUsedAt: NOW - DAY }),
        row({ skillName: "healthy", lastUsedAt: NOW - DAY }),
      ],
      now: NOW,
    });
    expect(report.totalCandidates).toBe(3);
    expect(report.transitions.map((t) => t.skillName)).toEqual(["stale-by-age"]);
    expect(report.borderlineCandidates.map((t) => t.skillName)).toEqual(["high-error"]);
    expect(report.noops.map((t) => t.skillName)).toEqual(["healthy"]);
  });

  it("collects pinned names into pinnedSkipped without proposing transitions", () => {
    const report = runHeuristicPass({
      candidates: [row({ skillName: "active" })],
      pinned: [row({ skillName: "pinned-1", pinned: true })],
      now: NOW,
    });
    expect(report.pinnedSkipped).toEqual(["pinned-1"]);
    expect(report.transitions).toEqual([]);
  });

  it("propagates dryRun and appliedWrites flags into the report", () => {
    const dry = runHeuristicPass({ candidates: [], now: NOW, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.appliedWrites).toBe(false);

    const live = runHeuristicPass({ candidates: [], now: NOW, appliedWrites: true });
    expect(live.dryRun).toBe(false);
    expect(live.appliedWrites).toBe(true);
  });
});

describe("formatReportMarkdown", () => {
  it("includes header, counts, and per-section listings", () => {
    const report = runHeuristicPass({
      candidates: [
        row({ skillName: "stale-x", usageCount: 0, createdAt: NOW - 20 * DAY, lastUsedAt: null }),
        row({ skillName: "flagged-y", usageCount: 20, errorCount: 15, lastUsedAt: NOW - DAY }),
      ],
      pinned: [row({ skillName: "p-z", pinned: true })],
      now: NOW,
      dryRun: true,
    });
    const md = formatReportMarkdown(report);
    expect(md).toContain("Skill Curator Report");
    expect(md).toContain("dry-run");
    expect(md).toContain("**Candidates scanned:** 2");
    expect(md).toContain("**Pinned skipped:** 1");
    expect(md).toContain("`stale-x`");
    expect(md).toContain("`flagged-y`");
    expect(md).toContain("`p-z`");
  });

  it("omits empty sections", () => {
    const report = runHeuristicPass({
      candidates: [row({ skillName: "healthy", lastUsedAt: NOW - DAY })],
      now: NOW,
    });
    const md = formatReportMarkdown(report);
    expect(md).not.toContain("## Transitions");
    expect(md).not.toContain("## Borderline");
    expect(md).not.toContain("## Pinned");
  });
});

describe("DEFAULT_THRESHOLDS", () => {
  it("defines sane numeric defaults", () => {
    expect(DEFAULT_THRESHOLDS.staleAfterUnusedDays).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.archiveAfterLastUsedDays).toBeGreaterThan(
      DEFAULT_THRESHOLDS.staleAfterLastUsedDays,
    );
    expect(DEFAULT_THRESHOLDS.errorRateFlagThreshold).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.errorRateFlagThreshold).toBeLessThanOrEqual(1);
    expect(DEFAULT_THRESHOLDS.reactivateIfUsedWithinDays).toBeLessThan(
      DEFAULT_THRESHOLDS.staleAfterLastUsedDays,
    );
  });
});
