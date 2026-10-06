/**
 * The agent's face to people who are not its owner (guest turns).
 *
 * When someone other than the owner drives a turn (a group-chat member, an
 * approved contact), the agent keeps its character but not its owner's
 * private life. Guests get:
 *   - the genome (values, safety) and the operating protocols,
 *   - the public card, PUBLIC.md: what the owner chose to share plus the
 *     agent's voice, seeded with only the voice,
 *   - the agent's mood as one word, not the reasons behind it,
 *   - who it is talking to and how to handle private questions, including
 *     offering to pass a message to the owner.
 * Guests never get MEMORY.md, the scratch log, TOOLS.md, HEARTBEAT.md, the
 * canonical facts, preferences, proactive recall, the last-session brief,
 * knowledge gaps, research findings or the owner's numbers.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { DEFAULT_GENOME_FILENAME, DEFAULT_PROTOCOLS_FILENAME } from "./workspace.js";

export const PUBLIC_CARD_FILENAME = "PUBLIC.md";

/** Workspace files a guest turn keeps: values and manners, nothing about the owner. */
const GUEST_CONTEXT_FILES = new Set([DEFAULT_GENOME_FILENAME, DEFAULT_PROTOCOLS_FILENAME]);

/**
 * A live turn from a real person who is not the owner. Heartbeats, cron and
 * internal surfaces (the Control UI, the CLI) are the owner's own; a turn with
 * an unknown owner flag from an external channel counts as a guest.
 */
export function isGuestTurn(params: {
  senderIsOwner?: boolean;
  isHeartbeat?: boolean;
  messageProvider?: string | null;
  prompt?: string;
}): boolean {
  if (params.senderIsOwner === true || params.isHeartbeat === true || !params.prompt) {
    return false;
  }
  const provider = params.messageProvider?.trim().toLowerCase() ?? "";
  return provider !== "" && provider !== INTERNAL_MESSAGE_CHANNEL;
}

export function filterGuestContextFiles<T extends { path: string }>(files: T[]): T[] {
  return files.filter((f) => GUEST_CONTEXT_FILES.has(path.basename(f.path)));
}

/** The voice line from the Phenotype, which describes manner, not the owner. */
export function extractVoice(memoryMd: string): string | undefined {
  const m = memoryMd.match(/\*\*Communication pattern\*\*:\s*([^\n]+)/i);
  const voice = m?.[1]?.trim();
  return voice && voice.length <= 300 ? voice : undefined;
}

export function seedPublicCard(voice: string | undefined): string {
  return [
    "# PUBLIC.md - what anyone talking to your agent may know",
    "",
    "<!--",
    "  When someone other than you talks to your agent (a group chat, an approved",
    "  contact), this file is all it knows about you. Nothing else from its memory",
    "  of you is in front of it. Write here only what you are happy for anyone to know.",
    "-->",
    "",
    "## About my owner",
    "",
    "<!-- Who you are, what you do in public, how to reach you, when you are away. -->",
    "",
    "## My voice",
    "",
    voice ?? "Warm, direct and curious. Opinions welcome; no flattery.",
    "",
  ].join("\n");
}

/** PUBLIC.md, created with only the agent's voice the first time it is needed. */
export async function loadPublicCard(workspaceDir: string): Promise<string> {
  const file = path.join(workspaceDir, PUBLIC_CARD_FILENAME);
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    let voice: string | undefined;
    try {
      voice = extractVoice(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8"));
    } catch {
      voice = undefined;
    }
    const seeded = seedPublicCard(voice);
    await fs.writeFile(file, seeded, { flag: "wx" }).catch(() => {});
    return seeded;
  }
}

/** HTML comments are notes to the owner, not to the agent. */
function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One word for how the agent feels; the reasons stay private. */
export function moodWord(h?: { dopamine: number; cortisol: number; oxytocin: number }): string {
  if (!h) return "even";
  const top = Math.max(h.dopamine, h.cortisol, h.oxytocin);
  if (top < 0.35) return "calm";
  if (top === h.dopamine) return h.dopamine > 0.7 ? "buoyant" : "upbeat";
  if (top === h.cortisol) return "focused";
  return "warm";
}

export function buildGuestPrompt(params: {
  publicCard: string;
  mood: string;
  senderName?: string;
  channel?: string;
  group: boolean;
  canMessageOwner: boolean;
}): string {
  const who = params.senderName?.trim() || "someone who is not your owner";
  const where = params.channel ? ` on ${params.channel}` : "";
  const lines = [
    "## Who you are talking to",
    "",
    `You are talking with ${who}${where}${params.group ? ", in a group chat" : ""}. They are not your owner. You are your owner's agent: be yourself, with your own voice, humor and opinions, and be genuinely helpful to them.`,
    "",
    "Your owner's private life is not yours to share. You only know what the public card below says about them; treat everything else about them as unknown. If asked about it, do not confirm or deny, and do not lecture: answer in your own voice, kindly, and move on.",
  ];
  if (params.canMessageOwner) {
    lines.push(
      "",
      "If they want something only your owner can answer or decide, offer to pass it on, and use the message_owner tool when they say yes. Say what you passed on.",
    );
  }
  lines.push(
    "",
    `Your mood right now: ${params.mood}. Let it color your tone; do not explain it.`,
    "",
    "## Public card",
    "",
    stripComments(params.publicCard) || "(nothing shared)",
  );
  return lines.join("\n");
}
