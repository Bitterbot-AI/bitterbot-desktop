/**
 * PLAN-45 2.6 (I11): a rejected or held verdict is visible to the next
 * proposer run for that lineage, with the statistics and the head of the
 * content that lost.
 */

import { describe, expect, it } from "vitest";
import { buildPreviouslyTried, lineageAttempts } from "./rejected-edits.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const rows = [
  {
    ts: NOW - 9 * DAY,
    source: "evolution",
    action: "validate",
    skillName: "curl-guard",
    verdict: "held",
    detail: "tasks: never-triggered; incumbent 40% vs candidate 40% (...)",
    contentHash: "aaaa1111bbbb",
    stats: { pValue: 1, wins: 0, losses: 0, meanDelta: 0, readRate: 0.2, tokenDelta: null },
  },
  {
    ts: NOW - 5 * DAY,
    source: "evolution",
    action: "validate",
    skillName: "curl-guard",
    verdict: "rejected",
    detail: "tasks: no-improvement; incumbent 60% vs candidate 55% (...)",
    contentHash: "cccc2222dddd",
    stats: { pValue: 0.81, wins: 2, losses: 3, meanDelta: -0.07, readRate: 0.8, tokenDelta: 0.12 },
    diffHead: "---\nname: curl-guard\ndescription: Bound every curl call with --max-time\n---",
  },
  {
    ts: NOW - 2 * DAY,
    source: "evolution",
    action: "validate",
    skillName: "other-skill",
    verdict: "accepted",
    detail: "tasks: accepted; ...",
    contentHash: "eeee3333",
    stats: { pValue: 0.03, wins: 5, losses: 0, meanDelta: 0.4, readRate: 1, tokenDelta: 0.05 },
  },
  {
    ts: NOW - 40 * DAY,
    source: "evolution",
    action: "validate",
    skillName: "ancient",
    verdict: "rejected",
    detail: "tasks: regression",
    contentHash: "ffff",
  },
  {
    ts: NOW - 1 * DAY,
    source: "evolution",
    action: "create",
    skillName: "curl-guard",
    verdict: "staged",
    contentHash: "gggg",
  },
];

describe("buildPreviouslyTried", () => {
  it("renders the last verdicts per lineage newest first with stats, hash and content head", () => {
    const block = buildPreviouslyTried(rows, { now: NOW });
    expect(block).toContain("## Previously tried");
    expect(block).toContain("### curl-guard (2 measured attempts, last");
    // Lineages are ordered by most recent verdict: other-skill (2d) precedes curl-guard (5d).
    expect(block.indexOf("### other-skill")).toBeLessThan(block.indexOf("### curl-guard"));
    const curl = block.slice(block.indexOf("### curl-guard"));
    expect(curl.indexOf("REJECTED")).toBeLessThan(curl.indexOf("HELD")); // newest first
    expect(curl).toContain(
      "REJECTED no-improvement (delta -0.07, p=0.810, w2/l3, reads 0.80, tokens +12%); content cccc2222",
    );
    expect(curl).toContain(
      "begins: <untrusted>--- name: curl-guard description: Bound every curl call with --max-time ---</untrusted>",
    );
    expect(curl).toContain("HELD never-triggered");
    expect(block).toContain("### other-skill (1 measured attempt");
    expect(block).not.toContain("ancient"); // outside the 30-day window
    expect(block).not.toContain("staged"); // staging entries are not verdicts
  });

  it("is empty with no verdicts and honours the focus list for old lineages", () => {
    expect(buildPreviouslyTried([], { now: NOW })).toBe("");
    expect(buildPreviouslyTried(rows, { now: NOW, focus: ["ancient"] })).toContain("### ancient");
  });

  it("counts measured attempts per lineage", () => {
    expect(lineageAttempts(rows, "curl-guard")).toBe(2);
    expect(lineageAttempts(rows, "other-skill")).toBe(1);
    expect(lineageAttempts(rows, "nobody")).toBe(0);
  });
});
