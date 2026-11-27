/**
 * PLAN-64 Phase 3: the words behind a practice, for the Memory tab.
 *
 * A practice's evidence is a list of session line refs
 * (`session:<file>#L<n>`, written by correction capture and follow-up
 * learning). This turns a ref back into the line the owner said, so the
 * owner can see why a practice exists without opening a transcript.
 *
 * Bounded and read-only: only transcripts inside the agent's own sessions
 * directory are read (a ref is a stored string; one that points anywhere
 * else is shown without text), a transcript over the line-ref size limit is
 * not parsed, and one request parses each file at most once and at most
 * MAX_FILES_PER_REQUEST files. The text goes through the same redaction the
 * session index uses (buildSessionEntry).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { MAX_TRANSCRIPT_BYTES_FOR_LINE_REF } from "./correction-capture.js";

const log = createSubsystemLogger("memory/practice-evidence");

export const MAX_EVIDENCE_TEXT_CHARS = 240;
const MAX_FILES_PER_REQUEST = 24;

export type PracticeEvidence = {
  /** The stored ref, as is. */
  ref: string;
  /** The owner's line, or null when it cannot be read. */
  text: string | null;
};

/** `session:<file>#L<n>` -> file and 1-based line of the flattened transcript. */
export function parseSessionLineRef(ref: string): { file: string; line: number } | null {
  const m = /^session:(.+)#L(\d+)$/.exec(ref.trim());
  if (!m) {
    return null;
  }
  const line = Number(m[2]);
  return m[1] && Number.isInteger(line) && line >= 1 ? { file: m[1], line } : null;
}

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** One resolver per request: the cache lives as long as the returned function. */
export function createPracticeEvidenceResolver(opts: {
  /** The agent's session transcripts directory; nothing outside it is read. */
  sessionsDir: string;
}): (refs: string[]) => Promise<PracticeEvidence[]> {
  const cache = new Map<string, string[] | null>();

  const linesOf = async (file: string): Promise<string[] | null> => {
    const cached = cache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    let lines: string[] | null = null;
    if (cache.size < MAX_FILES_PER_REQUEST && isInside(opts.sessionsDir, file)) {
      try {
        if ((await fs.stat(file)).size <= MAX_TRANSCRIPT_BYTES_FOR_LINE_REF) {
          const { buildSessionEntry } = await import("./session-files.js");
          lines = (await buildSessionEntry(file))?.content.split("\n") ?? null;
        }
      } catch (err) {
        log.debug(`evidence transcript unreadable: ${String(err)}`);
      }
    }
    cache.set(file, lines);
    return lines;
  };

  return async (refs) => {
    const out: PracticeEvidence[] = [];
    for (const ref of refs) {
      const parsed = parseSessionLineRef(ref);
      const line = parsed ? (await linesOf(parsed.file))?.[parsed.line - 1] : undefined;
      // Evidence is the owner's own line; anything else at that position
      // means the transcript changed since the ref was written.
      const text = line?.startsWith("User: ")
        ? line.slice("User: ".length).replace(/\s+/g, " ").trim()
        : "";
      out.push({
        ref,
        text: text
          ? text.length > MAX_EVIDENCE_TEXT_CHARS
            ? `${text.slice(0, MAX_EVIDENCE_TEXT_CHARS - 3)}...`
            : text
          : null,
      });
    }
    return out;
  };
}
