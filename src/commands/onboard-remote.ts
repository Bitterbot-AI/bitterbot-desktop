import type { BitterbotConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:19001";

function ensureWsUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_GATEWAY_URL;
  }
  return trimmed;
}

export async function promptRemoteGatewayConfig(
  cfg: BitterbotConfig,
  prompter: WizardPrompter,
): Promise<BitterbotConfig> {
  const suggestedUrl = cfg.gateway?.remote?.url ?? DEFAULT_GATEWAY_URL;

  const urlInput = await prompter.text({
    message: "Gateway WebSocket URL",
    initialValue: suggestedUrl,
    validate: (value) =>
      String(value).trim().startsWith("ws://") || String(value).trim().startsWith("wss://")
        ? undefined
        : "URL must start with ws:// or wss://",
  });
  const url = ensureWsUrl(String(urlInput));

  const authChoice = await prompter.select({
    message: "Gateway auth",
    options: [
      { value: "token", label: "Token (recommended)" },
      { value: "off", label: "No auth" },
    ],
  });

  let token = cfg.gateway?.remote?.token ?? "";
  if (authChoice === "token") {
    token = String(
      await prompter.text({
        message: "Gateway token",
        initialValue: token,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
  } else {
    token = "";
  }

  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      mode: "remote",
      remote: {
        url,
        token: token || undefined,
      },
    },
  };
}
