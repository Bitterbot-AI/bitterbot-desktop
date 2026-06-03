import { describe, expect, it } from "vitest";
import { buildRelationshipTemporalWhereClause } from "./temporal-filter.js";

describe("buildRelationshipTemporalWhereClause (PLAN-23 SABM)", () => {
  it("uses the relationships vocabulary (valid_until), not the chunks vocabulary", () => {
    const c = buildRelationshipTemporalWhereClause({}, "r");
    expect(c.sql).toContain("r.valid_until IS NULL");
    expect(c.sql).not.toContain("valid_time_end");
    expect(c.sql).not.toContain("valid_time_start");
    expect(c.params).toEqual([]);
  });

  it("drops the active-only guard when includeClosed is true", () => {
    const c = buildRelationshipTemporalWhereClause({ includeClosed: true }, "r");
    expect(c.sql).not.toContain("valid_until IS NULL");
    expect(c.sql).toBe("");
  });

  it("emits point-in-time validity over valid_from / valid_until", () => {
    const c = buildRelationshipTemporalWhereClause({ validAt: 1000 }, "r");
    expect(c.sql).toContain("r.valid_from IS NULL OR r.valid_from <= ?");
    expect(c.sql).toContain("r.valid_until IS NULL OR r.valid_until > ?");
    expect(c.params).toEqual([1000, 1000]);
  });

  it("includeClosed + validAt surfaces closed edges but still bounds by time", () => {
    const c = buildRelationshipTemporalWhereClause({ validAt: 500, includeClosed: true }, "r");
    // No standalone active-only guard, but the point-in-time bounds remain.
    expect(c.sql).toContain("r.valid_from");
    expect(c.params).toEqual([500, 500]);
  });

  it("respects a custom alias", () => {
    const c = buildRelationshipTemporalWhereClause({}, "rel");
    expect(c.sql).toContain("rel.valid_until IS NULL");
  });
});
