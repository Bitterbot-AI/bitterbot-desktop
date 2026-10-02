import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { wrapToolWithUpdateGuard } from "./agent-tools.update-guard.js";

type Update = (partial: unknown) => void;

function toolThat(run: (onUpdate: Update | undefined) => Promise<void>): AnyAgentTool {
  return {
    name: "exec",
    label: "exec",
    description: "exec",
    parameters: {},
    execute: async (_id: string, _params: unknown, _signal: unknown, onUpdate?: Update) => {
      await run(onUpdate);
      return { content: [{ type: "text", text: "running in the background" }], details: {} };
    },
  } as unknown as AnyAgentTool;
}

describe("tool progress updates", () => {
  it("are delivered while the call is in flight", async () => {
    const seen = vi.fn();
    const tool = wrapToolWithUpdateGuard(
      toolThat(async (onUpdate) => {
        onUpdate?.({ chunk: 1 });
        onUpdate?.({ chunk: 2 });
      }),
    );
    await tool.execute!("call-1", {}, undefined, seen);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("are dropped once the call has returned (a backgrounded command printing later)", async () => {
    // What pi-agent-core's callback does when no run is active.
    const seen = vi.fn(() => {
      throw new Error("Agent listener invoked outside active run");
    });
    let late: Update | undefined;
    const tool = wrapToolWithUpdateGuard(
      toolThat(async (onUpdate) => {
        late = onUpdate;
      }),
    );
    await tool.execute!("call-1", {}, undefined, seen);
    expect(() => late?.({ chunk: "finished" })).not.toThrow();
    expect(seen).not.toHaveBeenCalled();
  });

  it("are dropped after a call that threw", async () => {
    const seen = vi.fn();
    let late: Update | undefined;
    const tool = wrapToolWithUpdateGuard(
      toolThat(async (onUpdate) => {
        late = onUpdate;
        throw new Error("tool failed");
      }),
    );
    await expect(tool.execute!("call-1", {}, undefined, seen)).rejects.toThrow("tool failed");
    late?.({ chunk: "late" });
    expect(seen).not.toHaveBeenCalled();
  });

  it("do not fail the call when the callback throws mid-flight", async () => {
    const tool = wrapToolWithUpdateGuard(
      toolThat(async (onUpdate) => {
        onUpdate?.({ chunk: 1 });
      }),
    );
    const result = await tool.execute!("call-1", {}, undefined, () => {
      throw new Error("listener blew up");
    });
    expect(result.content).toEqual([{ type: "text", text: "running in the background" }]);
  });
});
