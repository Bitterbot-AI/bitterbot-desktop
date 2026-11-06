import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions, GatewayClient } from "./types.js";
const append = vi.hoisted(() => vi.fn(async (entry: unknown) => entry));
vi.mock("../../memory/skill-evolution/run-feedback.js", () => ({ appendRunFeedback: append }));
const { skillsHandlers } = await import("./skills.js");

describe("skill feedback owner authority", () => {
  it.each([
    ["owner admin", { connect: { role: "operator", scopes: ["operator.admin"] } }, true],
    ["read operator", { connect: { role: "operator", scopes: ["operator.read"] } }, false],
    ["node", { connect: { role: "node", scopes: ["operator.admin"] } }, false],
    [
      "setup connection",
      { connect: { role: "operator", scopes: ["operator.admin"] }, setupToken: "fixture" },
      false,
    ],
    ["internal unproven caller", null, false],
  ] as const)("stamps trusted authority only for %s", async (_label, client, owner) => {
    append.mockClear();
    const respond = vi.fn();
    await skillsHandlers["skills.evolution.feedback"]({
      params: { runId: "run-1", verdict: "confirmed", by: "operator" },
      client: client as GatewayClient | null,
      respond,
    } as GatewayRequestHandlerOptions);
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(append.mock.calls[0][0]).toMatchObject({ runId: "run-1", verdict: "confirmed" });
    expect((append.mock.calls[0][0] as { authority?: string }).authority).toBe(
      owner ? "owner-operator" : undefined,
    );
  });
  it("does not accept an authority flag supplied through RPC params", async () => {
    append.mockClear();
    const respond = vi.fn();
    await skillsHandlers["skills.evolution.feedback"]({
      params: { runId: "run-1", verdict: "confirmed", authority: "owner-operator" },
      client: null,
      respond,
    } as GatewayRequestHandlerOptions);
    expect(respond.mock.calls[0][0]).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });
});
