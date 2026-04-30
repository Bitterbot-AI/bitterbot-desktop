import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setActiveOrchestratorBridge,
  type OrchestratorBridge,
} from "../../infra/orchestrator-bridge.js";
import { createComputerUseTool } from "./computer-use-tool.js";

type Spies = {
  computerScreenshot: ReturnType<typeof vi.fn>;
  computerScreenSize: ReturnType<typeof vi.fn>;
  computerMouseMove: ReturnType<typeof vi.fn>;
  computerMouseClick: ReturnType<typeof vi.fn>;
  computerType: ReturnType<typeof vi.fn>;
  computerKey: ReturnType<typeof vi.fn>;
};

function makeFakeBridge(): { spies: Spies; bridge: OrchestratorBridge } {
  const spies: Spies = {
    computerScreenshot: vi
      .fn()
      .mockResolvedValue({ ok: true, png_base64: "abc", width: 100, height: 50 }),
    computerScreenSize: vi.fn().mockResolvedValue({ ok: true, width: 1920, height: 1080 }),
    computerMouseMove: vi.fn().mockResolvedValue({ ok: true, x: 10, y: 20 }),
    computerMouseClick: vi.fn().mockResolvedValue({ ok: true, button: "left" }),
    computerType: vi.fn().mockResolvedValue({ ok: true, typed: 5 }),
    computerKey: vi.fn().mockResolvedValue({ ok: true, key: "Return" }),
  };
  return { spies, bridge: spies as unknown as OrchestratorBridge };
}

describe("computer_use tool", () => {
  let spies: Spies;

  beforeEach(() => {
    const made = makeFakeBridge();
    spies = made.spies;
    setActiveOrchestratorBridge(made.bridge);
  });

  afterEach(() => {
    setActiveOrchestratorBridge(null);
  });

  it("routes screenshot to bridge.computerScreenshot", async () => {
    const tool = createComputerUseTool();
    const result = await tool.execute("call-1", { action: "screenshot", monitorIndex: 1 });
    expect(spies.computerScreenshot).toHaveBeenCalledWith(1);
    expect(result.details).toMatchObject({ ok: true, png_base64: "abc" });
  });

  it("routes mouse_move and validates x/y", async () => {
    const tool = createComputerUseTool();
    const ok = await tool.execute("call-2", { action: "mouse_move", x: 50, y: 75 });
    expect(spies.computerMouseMove).toHaveBeenCalledWith(50, 75);
    expect(ok.details).toMatchObject({ ok: true });

    const missing = await tool.execute("call-3", { action: "mouse_move", x: 50 });
    expect(missing.details).toMatchObject({
      ok: false,
      error: expect.stringContaining("requires x and y"),
    });
  });

  it("normalizes invalid mouse buttons to 'left'", async () => {
    const tool = createComputerUseTool();
    await tool.execute("call-4", { action: "mouse_click", button: "wibble" });
    expect(spies.computerMouseClick).toHaveBeenCalledWith("left");
  });

  it("rejects 'type' without text", async () => {
    const tool = createComputerUseTool();
    const result = await tool.execute("call-5", { action: "type" });
    expect(result.details).toMatchObject({ ok: false });
  });

  it("returns a clear error when no bridge is registered", async () => {
    setActiveOrchestratorBridge(null);
    const tool = createComputerUseTool();
    const result = await tool.execute("call-6", { action: "screenshot" });
    expect(result.details).toMatchObject({
      ok: false,
      error: expect.stringContaining("orchestrator daemon not connected"),
    });
  });
});
