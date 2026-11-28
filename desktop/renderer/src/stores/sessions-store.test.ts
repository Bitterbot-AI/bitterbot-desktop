import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGatewayStore } from "./gateway-store";
import { groupByRecency, sessionTitle, useSessionsStore } from "./sessions-store";

const request = vi.fn();

beforeEach(() => {
  request.mockReset();
  useGatewayStore.setState({ status: "connected", request } as never);
  useSessionsStore.setState({ sessions: [] });
});

describe("conversation titles", () => {
  it("prefers the person's title, then the derived one, then the key", () => {
    expect(sessionTitle({ key: "k", label: "Mine", derivedTitle: "Derived" })).toBe("Mine");
    expect(sessionTitle({ key: "k", derivedTitle: "Derived" })).toBe("Derived");
    expect(sessionTitle({ key: "k", label: "  " })).toBe("k");
  });
});

describe("recency groups", () => {
  const now = new Date(2026, 10, 27, 15, 0, 0).getTime();
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();

  it("splits into disjoint Today, Previous 7 days and Older, newest first", () => {
    const groups = groupByRecency(
      [
        { key: "old", updatedAt: at(2026, 9, 1) },
        { key: "early-today", updatedAt: at(2026, 10, 27, 1) },
        { key: "yesterday", updatedAt: at(2026, 10, 26) },
        { key: "late-today", updatedAt: at(2026, 10, 27, 14) },
        { key: "week-edge", updatedAt: at(2026, 10, 20, 0) },
        { key: "just-older", updatedAt: at(2026, 10, 19, 23) },
        { key: "undated" },
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "Previous 7 days", "Older"]);
    expect(groups[0].sessions.map((s) => s.key)).toEqual(["late-today", "early-today"]);
    expect(groups[1].sessions.map((s) => s.key)).toEqual(["yesterday", "week-edge"]);
    expect(groups[2].sessions.map((s) => s.key)).toEqual(["just-older", "old", "undated"]);
  });

  it("drops empty groups", () => {
    const groups = groupByRecency([{ key: "a", updatedAt: now }], now);
    expect(groups.map((g) => g.id)).toEqual(["today"]);
    expect(groupByRecency([], now)).toEqual([]);
  });
});

describe("conversation actions", () => {
  it("loads the list with derived titles", async () => {
    request.mockResolvedValue({ sessions: [{ key: "a", derivedTitle: "A" }] });
    await useSessionsStore.getState().refresh();
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ includeDerivedTitles: true }),
    );
    expect(useSessionsStore.getState().sessions).toHaveLength(1);
  });

  it("keeps the last list when a refresh fails or the gateway is away", async () => {
    useSessionsStore.setState({ sessions: [{ key: "a" }] });
    request.mockRejectedValue(new Error("boom"));
    await useSessionsStore.getState().refresh();
    expect(useSessionsStore.getState().sessions).toHaveLength(1);

    request.mockReset();
    useGatewayStore.setState({ status: "disconnected" } as never);
    await useSessionsStore.getState().refresh();
    expect(request).not.toHaveBeenCalled();
  });

  it("renames through sessions.patch and shows the new title at once", async () => {
    useSessionsStore.setState({ sessions: [{ key: "a", derivedTitle: "Derived" }] });
    request.mockResolvedValue({});
    await useSessionsStore.getState().rename("a", "  Pilot handoff  ");
    expect(request).toHaveBeenCalledWith("sessions.patch", { key: "a", label: "Pilot handoff" });
    expect(sessionTitle(useSessionsStore.getState().sessions[0])).toBe("Pilot handoff");
  });

  it("clears the title back to the derived one when renamed to nothing", async () => {
    useSessionsStore.setState({ sessions: [{ key: "a", label: "Mine", derivedTitle: "Derived" }] });
    request.mockResolvedValue({});
    await useSessionsStore.getState().rename("a", "   ");
    expect(request).toHaveBeenCalledWith("sessions.patch", { key: "a", label: null });
    expect(sessionTitle(useSessionsStore.getState().sessions[0])).toBe("Derived");
  });

  it("leaves the title alone when the gateway refuses the rename", async () => {
    useSessionsStore.setState({ sessions: [{ key: "a", label: "Mine" }] });
    request.mockRejectedValue(new Error("label already in use: Taken"));
    await expect(useSessionsStore.getState().rename("a", "Taken")).rejects.toThrow();
    expect(useSessionsStore.getState().sessions[0].label).toBe("Mine");
  });

  it("deletes on the gateway before dropping the row", async () => {
    useSessionsStore.setState({ sessions: [{ key: "a" }, { key: "b" }] });
    request.mockRejectedValueOnce(new Error("nope"));
    await expect(useSessionsStore.getState().remove("a")).rejects.toThrow();
    expect(useSessionsStore.getState().sessions).toHaveLength(2);

    request.mockResolvedValueOnce({});
    await useSessionsStore.getState().remove("a");
    expect(request).toHaveBeenLastCalledWith("sessions.delete", { key: "a" });
    expect(useSessionsStore.getState().sessions.map((s) => s.key)).toEqual(["b"]);
  });
});
