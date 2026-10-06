import { describe, expect, it } from "vitest";
import { type ConnectorStatus, describeConnector } from "./ConnectorsView";

const c = (overrides: Partial<ConnectorStatus>): ConnectorStatus => ({
  name: "cal",
  transport: "http",
  enabled: true,
  trustWrites: false,
  state: "connected",
  tools: [
    { name: "list_events", readOnly: true },
    { name: "create_event", readOnly: false },
  ],
  ...overrides,
});

describe("describeConnector", () => {
  it("says how many tools and which ones wait for approval", () => {
    expect(describeConnector(c({})).text).toBe(
      "Connected · 2 tools · 1 that change things wait for your approval",
    );
    expect(describeConnector(c({ trustWrites: true })).text).toContain(
      "can change things without asking",
    );
  });

  it("covers off, connecting and a failed connection", () => {
    expect(describeConnector(c({ enabled: false })).text).toBe("Off");
    expect(describeConnector(c({ state: "connecting" })).text).toBe("Connecting…");
    expect(describeConnector(c({ state: "error", error: "401 Unauthorized" }))).toEqual({
      tone: "text-danger",
      text: "Not connected: 401 Unauthorized",
    });
  });

  it("asks for a sign-in instead of calling it an error", () => {
    expect(describeConnector(c({ state: "needs-sign-in", signInUrl: "https://a" })).text).toBe(
      "Needs you to sign in",
    );
  });
});
