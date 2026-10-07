import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildTemporalWhereClause, currentFactsOnly } from "./temporal-filter.js";

// Point-in-time reads must see facts that were true THEN, even if superseded
// since (Agent Memory Atlas review: `validAt` used to keep the default
// excludeSuperseded guard, so a historical read could never return them).
function db(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE chunks (id TEXT, valid_time_start INTEGER, valid_time_end INTEGER,
    transaction_time INTEGER)`);
  const ins = d.prepare(`INSERT INTO chunks VALUES (?, ?, ?, ?)`);
  ins.run("aws", 100, 200, 100); // deployed to AWS from 100, superseded at 200
  ins.run("azure", 200, null, 200); // Azure since 200
  return d;
}

const ids = (d: DatabaseSync, clause: { sql: string; params: number[] }) =>
  (
    d
      .prepare(`SELECT id FROM chunks c WHERE 1=1${clause.sql} ORDER BY id`)
      .all(...clause.params) as Array<{ id: string }>
  ).map((r) => r.id);

describe("buildTemporalWhereClause", () => {
  it("current reads exclude superseded facts", () => {
    expect(ids(db(), currentFactsOnly())).toEqual(["azure"]);
  });

  it("validAt answers what was true at that moment", () => {
    const d = db();
    expect(ids(d, buildTemporalWhereClause({ validAt: 150 }))).toEqual(["aws"]);
    expect(ids(d, buildTemporalWhereClause({ validAt: 250 }))).toEqual(["azure"]);
  });

  it("asOf is a time-travel read, and an explicit excludeSuperseded still wins", () => {
    const d = db();
    expect(ids(d, buildTemporalWhereClause({ asOf: 150 }))).toEqual(["aws"]);
    expect(ids(d, buildTemporalWhereClause({ validAt: 150, excludeSuperseded: true }))).toEqual([]);
  });
});
