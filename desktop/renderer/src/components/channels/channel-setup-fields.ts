/**
 * Guided-setup field descriptors per channel. Keys are ChannelSetupInput
 * fields understood by each channel's setup.applyAccountConfig on the
 * gateway. Channels absent from this map fall back to the Config tab.
 */
export interface SetupField {
  key: string;
  label: string;
  help?: string;
  placeholder?: string;
  sensitive?: boolean;
  optional?: boolean;
}

export interface ChannelSetupDescriptor {
  fields: SetupField[];
  /** True when the channel links via QR instead of (or in addition to) tokens. */
  qrLogin?: boolean;
  docsHint?: string;
}

export const CHANNEL_SETUP_DESCRIPTORS: Record<string, ChannelSetupDescriptor> = {
  telegram: {
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        help: "Create a bot with @BotFather in Telegram and paste its token.",
        placeholder: "123456:ABC-DEF...",
        sensitive: true,
      },
    ],
  },
  discord: {
    fields: [
      {
        key: "token",
        label: "Bot token",
        help: "Discord Developer Portal → your application → Bot → Reset Token.",
        placeholder: "MTA...",
        sensitive: true,
      },
    ],
  },
  slack: {
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        help: "Slack app → OAuth & Permissions → Bot User OAuth Token.",
        placeholder: "xoxb-...",
        sensitive: true,
      },
      {
        key: "appToken",
        label: "App token",
        help: "Slack app → Basic Information → App-Level Tokens (Socket Mode, connections:write).",
        placeholder: "xapp-...",
        sensitive: true,
      },
    ],
  },
  signal: {
    qrLogin: true,
    fields: [
      {
        key: "signalNumber",
        label: "Phone number",
        help: "The Signal account number in E.164 format. Link the device via QR first if this gateway is a new linked device.",
        placeholder: "+15551234567",
      },
      {
        key: "cliPath",
        label: "signal-cli path",
        help: "Leave blank when signal-cli is on PATH.",
        placeholder: "signal-cli",
        optional: true,
      },
      {
        key: "httpUrl",
        label: "External daemon URL",
        help: "Optional: URL of an already-running signal-cli HTTP daemon.",
        placeholder: "http://127.0.0.1:8080",
        optional: true,
      },
    ],
  },
  whatsapp: {
    qrLogin: true,
    fields: [],
    docsHint: "WhatsApp links by scanning a QR from the phone - no tokens needed.",
  },
};
