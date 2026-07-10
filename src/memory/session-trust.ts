/**
 * Session provenance trust for memory WRITE paths (PLAN-34 review finding M2,
 * hotfixed against PLAN-33 Phase 2).
 *
 * The session extraction pipeline mines EVERY transcript under the agent's
 * sessions dir — including A2A tasks, group/channel chats, circles, and
 * subagent runs whose content is authored by third parties. Structured
 * ground-truth writes (canonical ledger pins, user-preference directives)
 * must only ever derive from FIRST-PARTY sessions: the owner talking to
 * their own agent. Ordinary fact/episode crystals still extract from all
 * sessions — they flow through retrieval ranking and contradiction
 * machinery — but nothing a third party says may become an always-injected
 * canonical fact or a standing user preference.
 *
 * Trust resolves transcript file -> sessionId -> sessionKey via the
 * sessions.json store that lives beside the transcripts. Unknown mappings
 * (pruned store entries, orphaned files) FAIL CLOSED to "unknown", which the
 * write gates treat like untrusted: worst case a legitimate old session's
 * canonical routing is skipped, never the reverse.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/session-trust");

export type SessionTrust = "first_party" | "untrusted" | "unknown";

/**
 * Session-key tokens whose presence marks a session as carrying third-party
 * authored content. Matched against the colon-separated segments AFTER the
 * "agent:<id>:" prefix so an agent literally named "circle" cannot confuse
 * the classifier.
 */
const UNTRUSTED_TOKENS = new Set([
  "a2a",
  "a2a-task",
  "group",
  "channel",
  "circle",
  "circles",
  "guest",
  "subagent",
]);

/** Classify a full session key ("agent:<id>:<rest...>"). */
export function classifySessionKeyTrust(sessionKey: string): SessionTrust {
  const parts = sessionKey.toLowerCase().split(":");
  if (parts.length < 2 || parts[0] !== "agent") {
    return "unknown";
  }
  const rest = parts.slice(2);
  if (rest.length === 0) {
    return "first_party"; // bare "agent:<id>" — the main session
  }
  for (const token of rest) {
    if (UNTRUSTED_TOKENS.has(token)) {
      return "untrusted";
    }
    // Prefixed forms like "a2a-task" appear as one segment; also catch
    // "a2a-<anything>" without matching e.g. "canvas".
    if (token.startsWith("a2a-") || token.startsWith("subagent-")) {
      return "untrusted";
    }
  }
  return "first_party";
}

/**
 * Build a resolver from transcript file path -> trust, by reverse-mapping
 * sessionId -> sessionKey from the agent's sessions.json. Reads the store
 * once; cheap to rebuild per extraction run so freshly-created sessions are
 * seen. Any read/parse failure yields a resolver that answers "unknown"
 * (fail closed for ground-truth writes).
 */
export async function buildSessionTrustResolver(
  agentId: string,
): Promise<(transcriptAbsPath: string) => SessionTrust> {
  const byId = new Map<string, SessionTrust>();
  try {
    const dir = resolveSessionTranscriptsDirForAgent(agentId);
    const raw = await fs.readFile(path.join(dir, "sessions.json"), "utf-8");
    const store = JSON.parse(raw) as Record<string, { sessionId?: string } | undefined>;
    for (const [sessionKey, entry] of Object.entries(store)) {
      const sessionId = entry?.sessionId;
      if (typeof sessionId === "string" && sessionId) {
        byId.set(sessionId, classifySessionKeyTrust(sessionKey));
      }
    }
  } catch (err) {
    log.debug(`session trust store unavailable (fail closed): ${String(err)}`);
  }
  return (transcriptAbsPath: string) => {
    const base = path.basename(transcriptAbsPath).replace(/\.jsonl$/i, "");
    return byId.get(base) ?? "unknown";
  };
}
