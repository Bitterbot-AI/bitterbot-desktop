import { describe, expect, it } from "vitest";
import { createCuriosityStateTool } from "./curiosity-tool.js";

describe("curiosity tools follow the engine's switch", () => {
  it("exist when memory.curiosity.enabled is unset, as the engine runs then", () => {
    expect(createCuriosityStateTool({ config: {} })).not.toBeNull();
    expect(
      createCuriosityStateTool({ config: { memory: { curiosity: { enabled: false } } } }),
    ).toBeNull();
  });
});
