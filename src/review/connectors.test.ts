import { afterEach, describe, expect, it } from "vitest";
import { classifyToolCall } from "./classify.js";
import { resetConnectorsForTest, setConnectorTools } from "./connectors.js";

afterEach(() => resetConnectorsForTest());

describe("connector tools in review", () => {
  it("holds a connector tool that changes something, and lets reads through", () => {
    setConnectorTools("cal", [
      [
        "mcp__cal__create_event",
        { server: "cal", tool: "create_event", readOnly: false, trustWrites: false },
      ],
      [
        "mcp__cal__list_events",
        { server: "cal", tool: "list_events", readOnly: true, trustWrites: false },
      ],
    ]);

    expect(classifyToolCall("mcp__cal__create_event", { title: "Dentist" })).toEqual({
      cls: "connector",
      preview: 'cal: create_event {"title":"Dentist"}',
    });
    expect(classifyToolCall("mcp__cal__list_events", {})).toBeNull();
  });

  it("lets a trusted connector write, and forgets a connector's tools when it is replaced", () => {
    setConnectorTools("cal", [
      [
        "mcp__cal__create_event",
        { server: "cal", tool: "create_event", readOnly: false, trustWrites: true },
      ],
    ]);
    expect(classifyToolCall("mcp__cal__create_event", {})).toBeNull();

    setConnectorTools("cal", []);
    expect(classifyToolCall("mcp__cal__create_event", {})).toBeNull();
  });

  it("is shared with a second copy of this module, as the plugin SDK bundle has", async () => {
    // A fresh module instance stands in for the copy inside dist/plugin-sdk.
    const { vi } = await import("vitest");
    vi.resetModules();
    const other = await import("./connectors.js?copy");
    other.setConnectorTools("mail", [
      ["mcp__mail__send", { server: "mail", tool: "send", readOnly: false, trustWrites: false }],
    ]);

    expect(classifyToolCall("mcp__mail__send", { to: "x" })?.cls).toBe("connector");
  });
});
