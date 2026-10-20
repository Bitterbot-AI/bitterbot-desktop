/**
 * Who the agent already knows (PLAN-53 B3, "contact").
 *
 * A message to someone the agent has never dealt with waits for the owner;
 * a message to anyone it has dealt with does not. "Dealt with" means any of:
 *   - the owner approved a message to them before (review.sqlite),
 *   - they have a session: they wrote to the agent, or it wrote to them,
 *   - they are one of the owner's own addresses or an allow-listed sender,
 *   - they were approved through pairing.
 *
 * Addresses are compared loosely on purpose. Channels write the same person
 * as `+1 555 0100`, `whatsapp:+15550100` or `15550100@s.whatsapp.net`, and a
 * miss here interrupts the owner about someone they talk to every day. A
 * display name that cannot be matched to an id is treated as unknown: the
 * owner is asked once, and the approval is remembered under that name.
 */

import type { ContactRecipient } from "./classify.js";

const PREFIX =
  /^(whatsapp|telegram|tg|discord|slack|signal|imessage|sms|msteams|googlechat|irc|user|channel|group|dm):/;

/** One comparable form for an address, whatever channel wrote it. */
export function normalizeContact(raw: string): string {
  let t = raw.trim().toLowerCase();
  for (let i = 0; i < 3 && PREFIX.test(t); i += 1) {
    t = t.replace(PREFIX, "");
  }
  // Discord mention, WhatsApp user JID (with or without a device suffix).
  t = t.replace(/^<@!?(\d+)>$/, "$1");
  t = t.replace(/(:\d+)?@s\.whatsapp\.net$/, "");
  // A phone number in any punctuation is its digits.
  if (/^\+?[\d\s().-]{6,}$/.test(t)) {
    return t.replace(/\D/g, "");
  }
  return t.replace(/^@/, "");
}

export type KnownAddress = { channel?: string; address: string };

/** The set of addresses the agent already knows, built once and asked many times. */
export class KnownContacts {
  private readonly onChannel = new Set<string>();
  /** Known without a channel (an owner entry with no prefix): known everywhere. */
  private readonly anywhere = new Set<string>();
  private readonly all = new Set<string>();

  constructor(addresses: Iterable<KnownAddress> = []) {
    for (const entry of addresses) {
      this.add(entry);
    }
  }

  add(entry: KnownAddress): void {
    const address = normalizeContact(entry.address);
    // "*" is "anyone may write in", not a person the agent knows.
    if (!address || address === "*") {
      return;
    }
    const channel = entry.channel?.trim().toLowerCase();
    if (channel) {
      this.onChannel.add(`${channel}|${address}`);
    } else {
      this.anywhere.add(address);
    }
    this.all.add(address);
  }

  has(recipient: ContactRecipient): boolean {
    const address = normalizeContact(recipient.target);
    if (!address) {
      return false;
    }
    const channel = recipient.channel?.trim().toLowerCase();
    if (!channel) {
      // The call left the channel to the run; any channel's match will do.
      return this.all.has(address);
    }
    return this.onChannel.has(`${channel}|${address}`) || this.anywhere.has(address);
  }

  get size(): number {
    return this.all.size;
  }
}

/** The key an approved contact is remembered under. */
export function contactKey(recipient: ContactRecipient): string {
  return `${recipient.channel?.trim().toLowerCase() || "*"}|${normalizeContact(recipient.target)}`;
}

type SessionLike = {
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  deliveryContext?: { channel?: string; to?: string };
  origin?: { provider?: string; from?: string; to?: string };
};

/** Everyone a session store has a conversation with. */
export function addressesFromSessions(
  sessions: Readonly<Record<string, SessionLike | undefined>>,
): KnownAddress[] {
  const out: KnownAddress[] = [];
  for (const entry of Object.values(sessions)) {
    if (!entry) {
      continue;
    }
    const channel =
      entry.deliveryContext?.channel ??
      entry.lastChannel ??
      entry.channel ??
      entry.origin?.provider;
    for (const address of [
      entry.deliveryContext?.to,
      entry.lastTo,
      entry.origin?.from,
      entry.origin?.to,
    ]) {
      if (typeof address === "string" && address.trim()) {
        out.push({ channel, address });
      }
    }
  }
  return out;
}

type AllowList = { allowFrom?: unknown; dm?: { allowFrom?: unknown } };
type ChannelLike = AllowList & { accounts?: Record<string, AllowList | undefined> };

const entries = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.filter((v) => typeof v === "string" || typeof v === "number").map(String)
    : [];

/**
 * The owner's own addresses and the senders they allow-listed, from config.
 * An `ownerAllowFrom` entry may carry its channel as a prefix.
 */
export function addressesFromConfig(cfg: {
  commands?: { ownerAllowFrom?: unknown };
  channels?: Record<string, unknown>;
}): KnownAddress[] {
  const out: KnownAddress[] = [];
  for (const owner of entries(cfg.commands?.ownerAllowFrom)) {
    const match = /^([a-z]+):(.+)$/i.exec(owner.trim());
    out.push(
      match && PREFIX.test(`${match[1].toLowerCase()}:`)
        ? { channel: match[1].toLowerCase(), address: match[2] }
        : { address: owner },
    );
  }
  for (const [channel, raw] of Object.entries(cfg.channels ?? {})) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const conf = raw as ChannelLike;
    const lists = [conf, ...Object.values(conf.accounts ?? {})];
    for (const list of lists) {
      for (const address of [...entries(list?.allowFrom), ...entries(list?.dm?.allowFrom)]) {
        out.push({ channel, address });
      }
    }
  }
  return out;
}
