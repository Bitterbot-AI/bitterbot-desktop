/**
 * RLM Context Builder — Assembles context from session transcripts and
 * knowledge crystals for the RLM sandbox to explore.
 *
 * The context is a structured text string with clear sections and metadata,
 * designed to be efficiently searchable by the RLM sub-LLM via code.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { MemorySearchManager } from "../../memory/types.js";
import type { ContextBuildParams, RLMScope } from "./types.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";

type SessionTranscriptMessage = {
  role: string;
  text: string;
  timestamp?: number;
};

type SessionTranscript = {
  sessionId: string;
  filePath: string;
  messages: SessionTranscriptMessage[];
  messageCount: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
};

/** Estimate token count from character count (~4 chars/token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Format epoch ms to readable date string. */
function formatTimestamp(ts: number): string {
  return new Date(ts)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

/**
 * Parse a session JSONL file into structured messages.
 * Reads the raw JSONL and extracts user/assistant text content.
 */
async function parseSessionFile(absPath: string): Promise<SessionTranscript | null> {
  try {
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const messages: SessionTranscriptMessage[] = [];
    let sessionId = path.basename(absPath, ".jsonl");

    for (const line of lines) {
      if (!line.trim()) continue;
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      // Extract session metadata from header
      if (record.type === "session" && record.id) {
        sessionId = record.id;
        continue;
      }

      // Extract messages
      if (record.type !== "message") continue;
      const msg = record.message;
      if (!msg || typeof msg.role !== "string") continue;
      if (msg.role !== "user" && msg.role !== "assistant") continue;

      const text = extractText(msg.content);
      if (!text) continue;

      messages.push({
        role: msg.role,
        text,
        timestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined,
      });
    }

    if (messages.length === 0) return null;

    const timestamps = messages.map((m) => m.timestamp).filter((t): t is number => t !== undefined);
    return {
      sessionId,
      filePath: absPath,
      messages,
      messageCount: messages.length,
      firstTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
      lastTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
    };
  } catch {
    return null;
  }
}

/** Extract text content from a message content field (string or content blocks). */
function extractText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as any).type === "text" &&
      typeof (block as any).text === "string"
    ) {
      const text = (block as any).text.trim();
      if (text) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * List session JSONL files for an agent, sorted by modification time (newest first).
 */
async function listSessionFiles(
  agentId: string,
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const dir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => path.join(dir, e.name));

    const stats = await Promise.all(
      files.map(async (f) => {
        try {
          const stat = await fs.stat(f);
          return { path: f, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      }),
    );

    return stats
      .filter((s): s is { path: string; mtimeMs: number } => s !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  } catch {
    return [];
  }
}

/**
 * Build the context string for RLM deep recall.
 *
 * Returns a formatted text string containing session transcripts and optionally
 * knowledge crystals, suitable for programmatic exploration via the RLM sandbox.
 */
export async function buildDeepRecallContext(params: {
  agentId: string;
  scope: RLMScope;
  sessionKey?: string;
  includeMemory?: boolean;
  maxTokens?: number;
  memoryManager?: MemorySearchManager | null;
}): Promise<string> {
  const { agentId, scope, sessionKey, includeMemory = true, maxTokens = 500_000 } = params;

  const maxChars = maxTokens * 4; // ~4 chars per token
  const sections: string[] = [];
  let currentChars = 0;

  // -------------------------------------------------------------------------
  // Section 1: Session Transcripts
  // -------------------------------------------------------------------------
  const sessionFiles = await listSessionFiles(agentId);

  // Determine which sessions to include based on scope
  let filesToLoad: Array<{ path: string; mtimeMs: number }>;
  if (scope === "current_session" && sessionKey) {
    // Find the specific session file
    const match = sessionFiles.find((f) => path.basename(f.path, ".jsonl").includes(sessionKey));
    filesToLoad = match ? [match] : sessionFiles.slice(0, 1);
  } else if (scope === "recent_sessions") {
    // Load up to 10 most recent sessions
    filesToLoad = sessionFiles.slice(0, 10);
  } else {
    // all_sessions
    filesToLoad = sessionFiles;
  }

  const transcripts: SessionTranscript[] = [];
  for (const file of filesToLoad) {
    if (currentChars >= maxChars) break;
    const transcript = await parseSessionFile(file.path);
    if (transcript) {
      transcripts.push(transcript);
    }
  }

  if (transcripts.length > 0) {
    const totalMessages = transcripts.reduce((sum, t) => sum + t.messageCount, 0);
    const allTimestamps = transcripts
      .map((t) => [t.firstTimestamp, t.lastTimestamp])
      .flat()
      .filter((t): t is number => t !== undefined);
    const dateRange =
      allTimestamps.length >= 2
        ? `${formatTimestamp(Math.min(...allTimestamps))} to ${formatTimestamp(Math.max(...allTimestamps))}`
        : "unknown";

    sections.push(`=== SESSION HISTORY ===`);
    sections.push(`Sessions: ${transcripts.length}`);
    sections.push(`Total messages: ${totalMessages}`);
    sections.push(`Date range: ${dateRange}`);
    sections.push(`---`);

    for (const transcript of transcripts) {
      if (currentChars >= maxChars) break;

      sections.push(
        `\n--- Session: ${transcript.sessionId} (${transcript.messageCount} messages) ---`,
      );

      for (const msg of transcript.messages) {
        if (currentChars >= maxChars) {
          sections.push(`[... truncated due to token budget ...]`);
          break;
        }

        const ts = msg.timestamp ? formatTimestamp(msg.timestamp) : "??:??";
        const role = msg.role.toUpperCase();
        const line = `[${ts}] ${role}: ${msg.text}`;

        // Truncate very long individual messages
        const truncated =
          line.length > 5000 ? line.slice(0, 5000) + " [... message truncated ...]" : line;
        sections.push(truncated);
        currentChars += truncated.length;
      }
    }
  } else {
    sections.push(`=== SESSION HISTORY ===`);
    sections.push(`No session transcripts found.`);
  }

  // -------------------------------------------------------------------------
  // Section 2: Knowledge Crystals (via memory search)
  // -------------------------------------------------------------------------
  if (includeMemory && params.memoryManager && currentChars < maxChars) {
    // Include knowledge crystals from the memory directory.
    // We use a broad natural-language query rather than "*" (which may not work
    // with all embedding providers). Multiple diverse queries give better coverage.
    const crystalQueries = [
      "important facts decisions preferences",
      "technical patterns skills workflows",
      "recent goals tasks projects",
    ];
    const seenSnippets = new Set<string>();
    const allResults: Array<{ source: string; snippet: string }> = [];

    for (const q of crystalQueries) {
      try {
        const results = await params.memoryManager.search(q, { maxResults: 20 });
        for (const r of results) {
          const key = r.snippet.slice(0, 100);
          if (!seenSnippets.has(key)) {
            seenSnippets.add(key);
            allResults.push({ source: r.source, snippet: r.snippet });
          }
        }
      } catch {
        // Individual query failed — continue with others
      }
    }

    if (allResults.length > 0) {
      sections.push(`\n=== KNOWLEDGE CRYSTALS (${allResults.length} entries) ===`);
      for (const r of allResults) {
        if (currentChars >= maxChars) break;
        const sourceTag =
          r.source === "memory" ? "memory" : r.source === "sessions" ? "session" : r.source;
        const line = `[${sourceTag}] ${r.snippet}`;
        const truncated = line.length > 2000 ? line.slice(0, 2000) + " [...]" : line;
        sections.push(truncated);
        currentChars += truncated.length;
      }
    }
  }

  const fullContext = sections.join("\n");
  return fullContext;
}
