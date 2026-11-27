import { describe, expect, it } from "vitest";
import type { CronJob } from "../../stores/cron-store";
import { taughtPractices } from "./CronView";

const job = (extra: Record<string, unknown>): CronJob =>
  ({ id: "j1", schedule: "0 9 * * *", text: "report", enabled: true, ...extra }) as CronJob;

/** PLAN-64 Phase 5: cron.list carries what the owner taught each job. */
describe("taughtPractices", () => {
  it("reads the practices the gateway lists for a job", () => {
    expect(
      taughtPractices(
        job({ practices: [{ id: "p1", statement: "Include the unique counts", savedAt: 5 }] }),
      ),
    ).toEqual([{ id: "p1", statement: "Include the unique counts", savedAt: 5 }]);
  });

  it("is empty on an older gateway, and drops malformed entries", () => {
    expect(taughtPractices(job({}))).toEqual([]);
    expect(taughtPractices(job({ practices: "nope" }))).toEqual([]);
    expect(
      taughtPractices(
        job({ practices: [null, { id: "p1" }, { id: 2, statement: "x", savedAt: 1 }] }),
      ),
    ).toEqual([]);
  });
});
