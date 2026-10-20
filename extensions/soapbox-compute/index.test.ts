import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("packaged Compute entry", () => {
  it("delegates registration to the gateway runtime with the same plugin API", () => {
    const registerSoapbox = vi.fn();
    const api = { runtime: { compute: { registerSoapbox } } } as unknown as BitterbotPluginApi;
    plugin.register(api);
    expect(registerSoapbox).toHaveBeenCalledExactlyOnceWith(api);
  });
  it("reports an older gateway runtime clearly", () => {
    const api = { runtime: {} } as unknown as BitterbotPluginApi;
    expect(() => plugin.register(api)).toThrow("matching Bitterbot gateway runtime");
  });
});
