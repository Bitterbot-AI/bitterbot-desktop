import { describe, expect, it } from "vitest";
import { listGatewayMethods } from "./server-methods-list.js";

describe("gateway method list: usage surfaces", () => {
  it("advertises every usage RPC the Control UI and CLI call", () => {
    // The Control UI gates features on hello.features.methods; the three
    // sessions.usage* methods were dispatchable but never advertised.
    const methods = new Set(listGatewayMethods());
    for (const name of [
      "usage.status",
      "usage.cost",
      "sessions.usage",
      "sessions.usage.timeseries",
      "sessions.usage.logs",
    ]) {
      expect(methods.has(name), name).toBe(true);
    }
  });
});
