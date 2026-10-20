import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";
import { emptyPluginConfigSchema } from "bitterbot/plugin-sdk";
import { emailPlugin } from "./src/plugin.js";
import { setEmailRuntime } from "./src/runtime.js";

const plugin = {
  id: "email",
  name: "Email",
  description: "Email channel: IMAP in, SMTP out",
  configSchema: emptyPluginConfigSchema(),
  register(api: BitterbotPluginApi) {
    setEmailRuntime(api.runtime);
    // oxlint-disable-next-line typescript/no-explicit-any
    api.registerChannel({ plugin: emailPlugin as any });
  },
};

export default plugin;
