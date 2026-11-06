import type { BitterbotPluginApi } from "bitterbot/plugin-sdk";
import {
  approveDevicePairing,
  buildMobilePairUrl,
  createSetupCode,
  listDevicePairing,
  rejectDevicePairing,
  resolveMobileBaseUrls,
  SETUP_CODE_TTL_MS,
} from "bitterbot/plugin-sdk";

/**
 * `/pair`: pair a phone from a chat channel (PLAN-62).
 *
 * `/pair` replies with a one-time link (five minutes, single use) that opens
 * the Bitterbot phone app and claims a setup code with a key the phone makes
 * on the spot. The phone then shows a six-digit code; `/pair approve <code>`
 * here (or Approve in the Control UI) finishes it. The gateway token never
 * appears in the link or in this chat.
 */

type DevicePairPluginConfig = {
  /** Address the phone should open, e.g. https://box.tailnet.ts.net. */
  publicUrl?: string;
};

type PendingPairingRequest = {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  remoteIp?: string;
  confirmCode?: string;
  ts?: number;
};

function normalizeHttpBase(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const protocol =
      url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      return null;
    }
    return `${protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function formatConfirmCode(code: string | undefined): string {
  return code && code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : "";
}

function formatPendingRequests(pending: PendingPairingRequest[]): string {
  if (pending.length === 0) {
    return "No pending device pairing requests.";
  }
  const lines: string[] = ["Pending device pairing requests:"];
  for (const req of pending) {
    const label = req.displayName?.trim() || req.deviceId.slice(0, 12);
    const parts = [
      `- ${label}`,
      req.confirmCode ? `code ${formatConfirmCode(req.confirmCode)}` : null,
      req.platform?.trim() ? `platform ${req.platform.trim()}` : null,
      req.remoteIp?.trim() ? `ip ${req.remoteIp.trim()}` : null,
      `id ${req.requestId}`,
    ].filter(Boolean);
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

/** Pick the pending request the owner means: a confirmation code, a request id, or "latest". */
export function pickPendingRequest(
  pending: PendingPairingRequest[],
  requested: string | undefined,
): { request?: PendingPairingRequest; error?: string } {
  if (pending.length === 0) {
    return { error: "No pending device pairing requests." };
  }
  const wanted = requested?.trim();
  if (!wanted) {
    if (pending.length === 1) {
      return { request: pending[0] };
    }
    return {
      error:
        `${formatPendingRequests(pending)}\n\nMore than one is waiting. Approve one with ` +
        "/pair approve <six-digit code>.",
    };
  }
  if (wanted.toLowerCase() === "latest") {
    return { request: [...pending].toSorted((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0] };
  }
  const digits = wanted.replace(/[\s-]/g, "");
  if (/^\d{6}$/.test(digits)) {
    const match = pending.find((entry) => entry.confirmCode === digits);
    return match
      ? { request: match }
      : { error: "No pending phone shows that code. Check the number on the phone." };
  }
  const byId = pending.find((entry) => entry.requestId === wanted);
  return byId ? { request: byId } : { error: "Pairing request not found." };
}

export default function register(api: BitterbotPluginApi) {
  api.registerCommand({
    name: "pair",
    description: "Pair a phone with a one-time link, and approve pairing requests.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const tokens = args.split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase() ?? "";
      api.logger.info?.(
        `device-pair: /pair invoked channel=${ctx.channel} action=${action || "new"}`,
      );

      if (action === "status" || action === "pending") {
        const list = await listDevicePairing();
        return { text: formatPendingRequests(list.pending) };
      }

      if (action === "approve" || action === "reject") {
        const list = await listDevicePairing();
        const picked = pickPendingRequest(list.pending, tokens.slice(1).join(" "));
        if (!picked.request) {
          return { text: picked.error ?? "Pairing request not found." };
        }
        if (action === "reject") {
          await rejectDevicePairing(picked.request.requestId);
          return { text: "Pairing request rejected." };
        }
        const approved = await approveDevicePairing(picked.request.requestId);
        if (!approved) {
          return { text: "Pairing request not found." };
        }
        const label = approved.device.displayName?.trim() || "the device";
        return { text: `Paired ${label}. You can rename or remove it in the Control UI.` };
      }

      const pluginCfg = (api.pluginConfig ?? {}) as DevicePairPluginConfig;
      const bases: string[] = [];
      const override =
        typeof pluginCfg.publicUrl === "string" ? normalizeHttpBase(pluginCfg.publicUrl) : null;
      if (override) {
        bases.push(override);
      }
      for (const base of await resolveMobileBaseUrls(api.config)) {
        if (!bases.includes(base.url)) {
          bases.push(base.url);
        }
      }
      if (bases.length === 0) {
        return {
          text:
            "This gateway only listens on this computer, so a phone cannot reach it. " +
            "Turn on Tailscale Serve (gateway.tailscale.mode=serve), bind to your network " +
            "(gateway.bind=lan), or set gateway.mobile.publicUrl, then try /pair again.",
        };
      }
      const created = createSetupCode({ createdBy: `${ctx.channel}:/pair` });
      const minutes = Math.round(SETUP_CODE_TTL_MS / 60_000);
      const [first, ...rest] = bases.map((base) => buildMobilePairUrl(base, created.code));
      const lines = [
        `Open this link on your phone within ${minutes} minutes (it works once):`,
        first,
        "",
        "Your phone will show a six-digit code. If it is the phone you expect, reply:",
        "/pair approve <code>",
      ];
      if (rest.length > 0) {
        lines.push("", "Other addresses for this gateway:", ...rest);
      }
      return { text: lines.join("\n") };
    },
  });
}
