/**
 * `message_owner`: a guest asks the agent to pass something on to its owner
 * (a question only the owner can answer, a request, an invitation). Offered
 * only on guest turns, so "I can't tell you that" can become "I'll ask".
 * Delivered as an owner notice; capped per sender so a guest cannot flood the
 * owner.
 */

import { Type } from "@sinclair/typebox";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const PER_HOUR = 3;
const PER_DAY = 10;
const sent = new Map<string, number[]>();

/** Whether this sender may send another message now; records it when so. */
export function takeMessageSlot(sender: string, now = Date.now()): boolean {
  const day = (sent.get(sender) ?? []).filter((t) => now - t < 24 * 60 * 60 * 1000);
  const hour = day.filter((t) => now - t < 60 * 60 * 1000);
  if (hour.length >= PER_HOUR || day.length >= PER_DAY) {
    sent.set(sender, day);
    return false;
  }
  sent.set(sender, [...day, now]);
  return true;
}

export function resetMessageOwnerForTest(): void {
  sent.clear();
}

export function createMessageOwnerTool(opts: {
  senderName?: string | null;
  senderId?: string | null;
  channel?: string | null;
  notify?: (notice: { kind: string; text: string; dedupeKey?: string }) => Promise<unknown>;
}): AnyAgentTool {
  const who = opts.senderName?.trim() || opts.senderId?.trim() || "Someone";
  const where = opts.channel?.trim() ? ` (${opts.channel.trim()})` : "";
  return {
    label: "Message Owner",
    name: "message_owner",
    description:
      "Pass a message from the person you are talking with to your owner, when they want something only your owner can answer or decide. Ask them first, keep it short and in their words, and tell them it was passed on. Never use it to send your owner's information anywhere.",
    parameters: Type.Object({
      message: Type.String({ description: "What to tell your owner, in one or two sentences." }),
    }),
    execute: async (_toolCallId, args) => {
      const message = readStringParam(args as Record<string, unknown>, "message", {
        required: true,
      })
        .replace(/\s+/g, " ")
        .slice(0, 600);
      const sender = `${opts.channel ?? ""}:${opts.senderId ?? who}`;
      if (!takeMessageSlot(sender)) {
        return jsonResult({
          ok: false,
          error: "Enough messages from this person for now. Tell them you'll pass it on later.",
        });
      }
      const notify =
        opts.notify ?? (async (n) => (await import("../../infra/owner-notify.js")).notifyOwner(n));
      await notify({
        kind: "guest-message",
        text: `${who}${where} asks: ${message}`,
        dedupeKey: `guest-message:${sender}:${message.slice(0, 80)}`,
      });
      return jsonResult({ ok: true, delivered: "Your owner will see it." });
    },
  };
}
