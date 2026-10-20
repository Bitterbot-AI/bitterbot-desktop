import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";
import { emptyPluginConfigSchema } from "bitterbot/plugin-sdk";
import { registerXCli } from "./src/cli.js";
import { xPlugin } from "./src/plugin.js";
import { setXRuntime } from "./src/runtime.js";

const plugin = {
  id: "x",
  name: "X",
  description: "X (Twitter) channel plugin: policy-gated original posts via the X API v2",
  configSchema: emptyPluginConfigSchema(),
  register(api: BitterbotPluginApi) {
    setXRuntime(api.runtime);
    // oxlint-disable-next-line typescript/no-explicit-any
    api.registerChannel({ plugin: xPlugin as any });
    api.registerCli(registerXCli, { commands: ["x"] });
  },
};

export default plugin;
