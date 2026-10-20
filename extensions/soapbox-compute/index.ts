import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";

export default {
  id: "soapbox-compute",
  register(api: BitterbotPluginApi) {
    if (!api.runtime.compute) {
      throw new Error("Compute requires a matching Bitterbot gateway runtime");
    }
    api.runtime.compute.registerSoapbox(api);
  },
};
