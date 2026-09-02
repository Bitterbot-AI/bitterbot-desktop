import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isA2aTaskSessionKey } from "../sessions/session-key-utils.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");

/**
 * PLAN-43 Phase 1 (R2): transcript files of inbound A2A task sessions —
 * turns driven by a REMOTE caller — must never become node state. This is
 * the single chokepoint every transcript miner shares (fact extraction,
 * session indexing incl. hormonal stimulation / preference extraction /
 * curiosity scoring, handover briefs, KG ingestion, architect corpus,
 * coverage diagnostics), so the exclusion lives here. The indexer's stale
 * sweep garbage-collects any chunks previously indexed from these files.
 *
 * Defense in depth: the task executor also mints self-describing
 * transcript ids ("a2a-<uuid>"), which the filename filter below drops
 * even when the sessions.json entry has been pruned or the store is
 * unreadable. (The store-based path covers any legacy a2a transcript
 * minted before the id prefix existed.) On a store read failure the
 * name-shape filter still applies; the trust resolver then answers
 * "unknown", which blocks ground-truth writes (canonical pins,
 * directives) but not ordinary indexing — hence the filename backstop.
 */
export function isRemoteTaskTranscriptName(name: string): boolean {
  return name.startsWith("a2a-");
}

const storeCache = new Map<string, { mtimeMs: number; ids: Set<string> }>();

async function loadRemoteTaskSessionIds(dir: string): Promise<Set<string>> {
  const storePath = path.join(dir, "sessions.json");
  try {
    const stat = await fs.stat(storePath);
    const cached = storeCache.get(storePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.ids;
    }
    const out = new Set<string>();
    const raw = await fs.readFile(storePath, "utf-8");
    const store = JSON.parse(raw) as Record<string, { sessionId?: string } | undefined>;
    for (const [sessionKey, entry] of Object.entries(store)) {
      const sessionId = entry?.sessionId;
      if (typeof sessionId === "string" && sessionId && isA2aTaskSessionKey(sessionKey)) {
        out.add(sessionId);
      }
    }
    storeCache.set(storePath, { mtimeMs: stat.mtimeMs, ids: out });
    return out;
  } catch {
    // Store unavailable: the filename-shape filter still applies.
    return new Set<string>();
  }
}

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  /** Maps each content line (0-indexed) to its 1-indexed JSONL source line. */
  lineMap: number[];
};

export async function listSessionFilesForAgent(agentId: string): Promise<string[]> {
  const dir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const remoteTaskIds = await loadRemoteTaskSessionIds(dir);
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".jsonl"))
      .filter((name) => !isRemoteTaskTranscriptName(name))
      .filter((name) => !remoteTaskIds.has(name.slice(0, -".jsonl".length)))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function sessionPathForFile(absPath: string): string {
  return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

export async function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected: string[] = [];
    const lineMap: number[] = [];
    for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
      const line = lines[jsonlIdx];
      if (!line.trim()) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !record ||
        typeof record !== "object" ||
        (record as { type?: unknown }).type !== "message"
      ) {
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractSessionText(message.content);
      if (!text) {
        continue;
      }
      const safe = redactSensitiveText(text, { mode: "tools" });
      const label = message.role === "user" ? "User" : "Assistant";
      collected.push(`${label}: ${safe}`);
      lineMap.push(jsonlIdx + 1);
    }
    const content = collected.join("\n");
    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content + "\n" + lineMap.join(",")),
      content,
      lineMap,
    };
  } catch (err) {
    log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
}
