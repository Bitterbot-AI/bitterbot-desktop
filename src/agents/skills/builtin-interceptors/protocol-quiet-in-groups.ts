/**
 * PLAN-20 reference interceptor #3: protocol-quiet-in-groups.
 *
 * Goal: in group channels (Discord guild, Telegram group, Slack channel),
 * if the bot hasn't been @mentioned in the last few turns and recently
 * spoke, suppress the next outbound message. Enforces PROTOCOLS.md's
 * "speak ~1 in 5 turns" rule deterministically.
 */

import type { CandidateAction, PreActionInterceptor, StepContext } from "../interceptor.js";
import { MESSAGE_TOOL_NAMES } from "./message-tools.js";

const GROUP_CHANNELS = new Set(["discord", "telegram", "whatsapp", "slack", "googlechat", "irc"]);
const MESSAGE_TOOLS = MESSAGE_TOOL_NAMES;

const MIN_TURNS_BETWEEN_SPEAKS = 5;
const MENTION_LOOKBACK = 3;
const MENTION_RX = /@bitterbot\b|@bot\b/i;

export const protocolQuietInGroups: PreActionInterceptor = {
  id: "protocol-quiet-in-groups:default",
  skill: "protocol-quiet-in-groups",
  priority: 90, // higher than recall-before-claim so we don't waste recall cost on a message we'll block
  maxFiresPerEpisode: 50,
  tools: MESSAGE_TOOLS,

  shouldActivate(ctx: StepContext, _action: CandidateAction): boolean {
    if (!GROUP_CHANNELS.has(ctx.channel)) return false;
    const recent = ctx.recentTurns.slice(-MENTION_LOOKBACK);
    const mentioned = recent.some((t) => t.role === "user" && MENTION_RX.test(t.preview));
    if (mentioned) return false;
    // Count assistant messages in recent toolHistory as "spoke this turn-window"
    const recentSpeaks = ctx.toolHistory.filter(
      (t) => MESSAGE_TOOLS.includes(t.tool) && t.tsDelta < 60_000,
    ).length;
    return recentSpeaks > 0 || ctx.turnNumber < MIN_TURNS_BETWEEN_SPEAKS;
  },

  intervene(_ctx: StepContext, _action: CandidateAction) {
    return {
      type: "block" as const,
      reason: "protocol-quiet-in-groups: PROTOCOLS.md group-channel cadence",
      // Silent block — the whole point is to not say anything visible.
    };
  },
};
