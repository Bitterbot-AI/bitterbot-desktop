export const GATEWAY_CLIENT_IDS = {
  WEBCHAT_UI: "webchat-ui",
  CONTROL_UI: "bitterbot-control-ui",
  WEBCHAT: "webchat",
  CLI: "cli",
  GATEWAY_CLIENT: "gateway-client",
  DESKTOP_APP: "bitterbot-desktop",
  MACOS_APP: "bitterbot-macos",
  IOS_APP: "bitterbot-ios",
  ANDROID_APP: "bitterbot-android",
  NODE_HOST: "node-host",
  TEST: "test",
  FINGERPRINT: "fingerprint",
  PROBE: "bitterbot-probe",
} as const;

export type GatewayClientId = (typeof GATEWAY_CLIENT_IDS)[keyof typeof GATEWAY_CLIENT_IDS];

// Back-compat naming (internal): these values are IDs, not display names.
export const GATEWAY_CLIENT_NAMES = GATEWAY_CLIENT_IDS;
export type GatewayClientName = GatewayClientId;

export const GATEWAY_CLIENT_MODES = {
  WEBCHAT: "webchat",
  CLI: "cli",
  UI: "ui",
  BACKEND: "backend",
  NODE: "node",
  PROBE: "probe",
  TEST: "test",
} as const;

export type GatewayClientMode = (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];

export type GatewayClientInfo = {
  id: GatewayClientId;
  displayName?: string;
  version: string;
  platform: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  mode: GatewayClientMode;
  instanceId?: string;
};

export const GATEWAY_CLIENT_CAPS = {
  TOOL_EVENTS: "tool-events",
} as const;

export type GatewayClientCap = (typeof GATEWAY_CLIENT_CAPS)[keyof typeof GATEWAY_CLIENT_CAPS];

const GATEWAY_CLIENT_ID_SET = new Set<GatewayClientId>(Object.values(GATEWAY_CLIENT_IDS));
const GATEWAY_CLIENT_MODE_SET = new Set<GatewayClientMode>(Object.values(GATEWAY_CLIENT_MODES));

/**
 * Client IDs that represent a human-facing UI (browser or native app) the
 * user runs directly. When connected over loopback these are considered
 * trusted: the user already has the machine, so demanding a device-pairing
 * handshake before any scoped operation is UX hostile (and was the root
 * cause of #4 — scopes being silently stripped, which surfaced in #6 as an
 * infinite spinner). CLI, gateway-client, node-host, test, probe, and
 * fingerprint clients are NOT in this set — they authenticate differently.
 */
const TRUSTED_LOCAL_UI_CLIENT_IDS: ReadonlySet<GatewayClientId> = new Set<GatewayClientId>([
  GATEWAY_CLIENT_IDS.CONTROL_UI,
  GATEWAY_CLIENT_IDS.WEBCHAT_UI,
  GATEWAY_CLIENT_IDS.WEBCHAT,
  GATEWAY_CLIENT_IDS.DESKTOP_APP,
  GATEWAY_CLIENT_IDS.MACOS_APP,
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);

/**
 * True when the client id belongs to a human-facing UI/native app that
 * should bypass device-pairing + keep its scopes when connecting over
 * loopback. Caller is responsible for verifying the request is actually
 * local (see isLocalDirectRequest).
 */
export function isTrustedLocalUiClientId(id: string | undefined | null): boolean {
  if (!id) {
    return false;
  }
  return TRUSTED_LOCAL_UI_CLIENT_IDS.has(id as GatewayClientId);
}

export function normalizeGatewayClientId(raw?: string | null): GatewayClientId | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return GATEWAY_CLIENT_ID_SET.has(normalized as GatewayClientId)
    ? (normalized as GatewayClientId)
    : undefined;
}

export function normalizeGatewayClientName(raw?: string | null): GatewayClientName | undefined {
  return normalizeGatewayClientId(raw);
}

export function normalizeGatewayClientMode(raw?: string | null): GatewayClientMode | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return GATEWAY_CLIENT_MODE_SET.has(normalized as GatewayClientMode)
    ? (normalized as GatewayClientMode)
    : undefined;
}

export function hasGatewayClientCap(
  caps: string[] | null | undefined,
  cap: GatewayClientCap,
): boolean {
  if (!Array.isArray(caps)) {
    return false;
  }
  return caps.includes(cap);
}
