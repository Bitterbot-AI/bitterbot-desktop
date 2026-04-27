import { describe, expect, it } from "vitest";
import { applyJobPatch, buildJobFromParams, jobToWire } from "./normalize.js";

describe("cron normalize", () => {
  it("accepts the canonical add shape and assigns a jobId when missing", () => {
    const job = buildJobFromParams({
      name: "Reminder",
      schedule: { kind: "at", at: "2099-01-01T00:00:00Z" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "test" },
      deleteAfterRun: true,
    });
    expect(job.jobId).toMatch(/^cron_[0-9a-f]+$/);
    expect(job.payload.kind).toBe("systemEvent");
    expect(job.deleteAfterRun).toBe(true);
  });

  it("supports the legacy wire shape used by the Control UI", () => {
    const job = buildJobFromParams({
      label: "Daily ping",
      schedule: "0 9 * * *",
      tz: "America/Los_Angeles",
      text: "Send me a daily summary.",
    });
    expect(job.name).toBe("Daily ping");
    expect(job.sessionTarget).toBe("isolated");
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("Send me a daily summary.");
    }
    expect(job.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "America/Los_Angeles" });
  });

  it("rejects mismatched payload + sessionTarget combinations", () => {
    expect(() =>
      buildJobFromParams({
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "main",
        payload: { kind: "agentTurn", message: "nope" },
      }),
    ).toThrow(/main session jobs require/);
  });

  it("translates updates through applyJobPatch with constraint enforcement", () => {
    const base = buildJobFromParams({
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "go" },
    });
    const patched = applyJobPatch(base, { enabled: false, name: "renamed" });
    expect(patched.enabled).toBe(false);
    expect(patched.name).toBe("renamed");
    expect(() => applyJobPatch(base, { sessionTarget: "main" })).toThrow(
      /main session jobs require/,
    );
  });

  it("renders the wire shape with derived sessionKey for isolated jobs", () => {
    const job = buildJobFromParams({
      jobId: "isol1",
      schedule: { kind: "cron", expr: "0 * * * *" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "morning" },
    });
    const wire = jobToWire(job);
    expect(wire.id).toBe("isol1");
    expect(wire.sessionKey).toBe("cron:isol1");
    expect(wire.text).toBe("morning");
  });
});
