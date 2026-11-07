/**
 * PLAN-62: what a paired phone may do, in one place.
 *
 * A phone holds a scoped device token, not the owner's authority. Until a
 * phone can prove the owner is present with a passkey (PLAN-62 slice B), a
 * phone is a NON-OWNER surface:
 *
 *   - Its chat turns run as a non-owner, so owner-only tools (exec, config,
 *     gateway control, anything gated by the owner flag) are refused.
 *   - Only harmless slash commands work from it (PHONE_ALLOWED_COMMANDS);
 *     every other command is refused before the turn starts, so nothing like
 *     /config, /pair or /approve can run from a phone.
 *   - It may answer approvals once, but never approve money (spends, compute
 *     funding) and never grant a standing "always allow".
 *
 * Every check that concerns a phone calls into this module, so the policy is
 * stated once and tested once.
 */

import { isMobileScopedConnection } from "./scopes.js";

export { isMobileScopedConnection };

/** True when a turn or a decision comes from a paired phone. */
export function isPhoneSurface(scopes: readonly string[] | undefined | null): boolean {
  return isMobileScopedConnection(scopes ?? undefined);
}

/**
 * Slash commands a phone may send. Conversation housekeeping and read-only
 * status; nothing that changes configuration, pairing, approvals or tools.
 */
export const PHONE_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "new",
  "reset",
  "stop",
  "status",
  "help",
  "commands",
]);

/** `/Status extra` -> "status"; null when the text is not a slash command. */
export function slashCommandName(text: string | undefined | null): string | null {
  const trimmed = (text ?? "").trimStart();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const match = /^\/([A-Za-z0-9_-]+)/.exec(trimmed);
  return match ? match[1].toLowerCase() : "";
}

/**
 * True when a phone may send this text as-is: ordinary chat, or a bare
 * allowed command. An unknown or empty command name is refused.
 */
export function isPhoneMessageAllowed(text: string | undefined | null): boolean {
  const name = slashCommandName(text);
  return name === null || PHONE_ALLOWED_COMMANDS.has(name);
}

/** True when the message is exactly an allowed command (used for command authorization). */
export function isPhoneCommandAllowed(text: string | undefined | null): boolean {
  const name = slashCommandName(text);
  return name !== null && PHONE_ALLOWED_COMMANDS.has(name);
}

/**
 * The part of a phone's conversation keys that ties them to that phone:
 * the first 12 letters/digits of its device id, lowercased. The app names new
 * conversations `mobile-<tag>-<time>` (desktop/renderer/src/mobile/session-key.ts).
 */
export function phoneSessionTag(deviceId: string | undefined | null): string | null {
  const tag = (deviceId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  return tag.length === 12 ? tag : null;
}

/**
 * Conversations a phone may read and write: the owner's main conversation and
 * the ones THIS phone started (`mobile-<its tag>-...`). Another phone's
 * conversations and channel conversations with other people (a WhatsApp DM, a
 * Discord channel) stay out of reach. Without a device id only main is allowed.
 */
export function isPhoneSessionAllowed(
  sessionKey: string | undefined | null,
  deviceId?: string | null,
): boolean {
  const key = (sessionKey ?? "").trim().toLowerCase();
  if (!key) {
    return false;
  }
  const rest = key.startsWith("agent:") ? key.split(":").slice(2).join(":") : key;
  if (rest === "main" || rest === "default") {
    return true;
  }
  const tag = phoneSessionTag(deviceId);
  const match = /^mobile-([a-z0-9]{12})(?:[-:][a-z0-9:_-]{1,80})?$/.exec(rest);
  return tag !== null && match !== null && match[1] === tag;
}

export const PHONE_SESSION_REFUSAL =
  "That conversation is only available on your computer. A paired phone can use the main conversation and the ones it started.";

export const PHONE_COMMAND_REFUSAL =
  "That command is only available on your computer. A paired phone can chat, use /new, /reset, /stop, /status and /help, and answer approvals.";

export const PHONE_MONEY_REFUSAL =
  "Payments and compute funding are approved on your computer for now; you can deny this one here.";

export const PHONE_ALWAYS_REFUSAL =
  "A phone can allow this once, but not always. Set standing permissions on your computer.";

/**
 * Why a phone may not make this decision, or null when it may. `cls` and
 * `tool` describe the held action; `always` is a request for standing
 * permission (review `always`, exec `allow-always`).
 */
export function phoneApprovalRefusal(params: {
  scopes: readonly string[] | undefined | null;
  decision: "approve" | "deny" | "allow-once" | "allow-always";
  cls?: string | null;
  tool?: string | null;
  always?: boolean;
}): string | null {
  if (!isPhoneSurface(params.scopes)) {
    return null;
  }
  if (params.decision === "deny") {
    return null;
  }
  if (params.always === true || params.decision === "allow-always") {
    return PHONE_ALWAYS_REFUSAL;
  }
  if (params.cls === "spend" || params.tool === "compute") {
    return PHONE_MONEY_REFUSAL;
  }
  return null;
}

/** RPCs whose `sessionKey` param a phone may only point at its own conversations. */
const PHONE_SESSION_PARAM_METHODS: ReadonlySet<string> = new Set([
  "chat.send",
  "chat.history",
  "chat.abort",
  "agent.identity.get",
]);

export type PhoneRequestGuard =
  | { ok: false; message: string }
  | {
      ok: true;
      params: Record<string, unknown>;
      /** Rewrites the response payload before it reaches the phone. */
      filterPayload?: (payload: unknown) => unknown;
    };

/**
 * Per-request session restrictions for a phone (the method scope check has
 * already passed). Conversations outside the phone's own and the main one are
 * invisible to it: refused by key, filtered out of lists and previews.
 */
export function guardPhoneRequest(
  method: string,
  params: Record<string, unknown>,
  deviceId?: string | null,
): PhoneRequestGuard {
  if (PHONE_SESSION_PARAM_METHODS.has(method)) {
    const key = params.sessionKey;
    if (key !== undefined && (typeof key !== "string" || !isPhoneSessionAllowed(key, deviceId))) {
      return { ok: false, message: PHONE_SESSION_REFUSAL };
    }
    if (key === undefined && method !== "agent.identity.get") {
      return { ok: false, message: PHONE_SESSION_REFUSAL };
    }
    return { ok: true, params };
  }
  if (method === "sessions.preview") {
    const keys = Array.isArray(params.keys) ? params.keys : [];
    return {
      ok: true,
      params: {
        ...params,
        keys: keys.filter((k) => typeof k === "string" && isPhoneSessionAllowed(k, deviceId)),
      },
    };
  }
  if (method === "sessions.list") {
    return {
      ok: true,
      params,
      filterPayload: (payload) => {
        const p = payload as { sessions?: Array<{ key?: unknown }>; count?: number } | null;
        if (!p || !Array.isArray(p.sessions)) {
          return payload;
        }
        const sessions = p.sessions.filter(
          (row) => typeof row?.key === "string" && isPhoneSessionAllowed(row.key, deviceId),
        );
        // Paths in the store listing are not the phone's business either.
        return { ...p, path: undefined, sessions, count: sessions.length };
      },
    };
  }
  return { ok: true, params };
}
