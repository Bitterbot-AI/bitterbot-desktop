/**
 * PLAN-62: the scopes a paired phone holds.
 *
 * A phone gets a per-device token bound to its device key, never the gateway
 * token. Its scopes are deliberately narrow: talk to the agent, answer the
 * approvals queue, receive notifications. No `operator.admin` (config,
 * updates, skills, sessions admin), no `operator.write` (node.invoke, browser
 * control, workspace writes, cron), no `operator.pairing` (a phone can never
 * approve another device), and no `operator.read` (logs, config, memory).
 *
 * `operator.chat` and `operator.notifications` are new, so no existing client
 * holds them; each grants exactly the methods listed here.
 */

export const CHAT_SCOPE = "operator.chat";
export const NOTIFICATIONS_SCOPE = "operator.notifications";
export const APPROVALS_SCOPE = "operator.approvals";

/** What a phone paired through a setup code is granted. Sorted, as tokens store them. */
export const MOBILE_DEVICE_SCOPES: readonly string[] = [
  APPROVALS_SCOPE,
  CHAT_SCOPE,
  NOTIFICATIONS_SCOPE,
];

/** The client id the phone app connects with. */
export const MOBILE_CLIENT_ID = "bitterbot-mobile";

/**
 * Methods `operator.chat` unlocks: the conversation itself, the session list
 * for the switcher, voice input, and the read-only status a glance view needs.
 */
export const CHAT_SCOPE_METHODS: ReadonlySet<string> = new Set([
  "chat.send",
  "chat.abort",
  "chat.history",
  "sessions.list",
  "sessions.preview",
  "talk.transcribe",
  "agent.identity.get",
  "dream.status",
  "dream.emotional",
  "dream.journal",
  "mobile.self.get",
  "mobile.self.rename",
  "mobile.self.unpair",
  "mobile.presence",
]);

/** Methods `operator.notifications` unlocks: the device's own push subscription. */
export const NOTIFICATIONS_SCOPE_METHODS: ReadonlySet<string> = new Set([
  "push.config",
  "push.subscribe",
  "push.unsubscribe",
  "push.settings",
  "push.test",
  "mobile.self.get",
  "mobile.self.unpair",
  "mobile.presence",
]);

/**
 * Server-only marker the handshake adds to a connection whose device was
 * paired as a phone (PairedDevice.principal). It never grants a method; it
 * only switches the phone policy on. A client gains nothing by sending it.
 */
export const PHONE_PRINCIPAL_SCOPE = "phone.principal";

/**
 * True when a connection is a phone. The authoritative signal is the marker
 * the handshake derives from the paired-device record, so asking for fewer
 * scopes (approvals only) can never shed the phone policy. Without the
 * marker, chat or notifications scopes without admin still count as a phone.
 */
export function isMobileScopedConnection(scopes: readonly string[] | undefined): boolean {
  if (!scopes) {
    return false;
  }
  if (scopes.includes(PHONE_PRINCIPAL_SCOPE)) {
    return true;
  }
  if (scopes.includes("operator.admin")) {
    return false;
  }
  return scopes.includes(CHAT_SCOPE) || scopes.includes(NOTIFICATIONS_SCOPE);
}
