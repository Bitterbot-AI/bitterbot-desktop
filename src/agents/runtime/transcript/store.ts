/**
 * PLAN-52 Phase 1: the owned transcript store.
 *
 * A reader/writer for session JSONL v3 with the same public surface as
 * pi-coding-agent's `SessionManager` (MIT, Mario Zechner / pi-mono), so it can
 * stand in for it behind the engine flag while the pi loop still drives the
 * turn, and so the 14 readers of the format are untouched.
 *
 * Deliberate differences from pi 0.73.1 (each has a differential test):
 *
 * 1. No duplicate header. pi resets `flushed` whenever a non-assistant entry
 *    is appended to a file that holds no assistant message, then re-appends
 *    every entry (header included) on the first assistant message. This store
 *    tracks how many entries are on disk and appends only the rest.
 * 2. No data loss on a damaged file. pi overwrites a file whose first line is
 *    not a valid header with a fresh header. This store moves the file aside
 *    (`<file>.corrupt.<timestamp>`) and starts a new session in its place.
 * 3. An empty file is treated like a missing one: nothing is written until
 *    the first assistant message (pi writes a header immediately).
 * 4. `getBranch` and `buildSessionContext` stop on a parent cycle instead of
 *    looping forever.
 * 5. An entry whose parent is missing from the file (a damaged line that the
 *    repair dropped) continues at the previous entry in file order; pi ends
 *    the path there and hides everything before it.
 * 6. Lines before the first valid header, and lines that are JSON but not an
 *    object, are skipped instead of invalidating the file or throwing.
 * 7. A torn last line (no trailing newline) is closed with a newline before
 *    the next append, so the new entry is not glued to it.
 * 8. An entry that cannot be serialized is rejected before it is added, and
 *    does not block later entries from reaching disk.
 *
 * `fileEntries`, `byId`, `labelsById`, `leafId`, `flushed` and `sessionId`
 * keep pi's names and are writable: `embedded-runner/session-manager-init.ts`
 * and the tool-result guard mutate them today. `appendMessage` is an
 * overridable instance member for the same reason. Those seams go away in
 * Phase 6; `setHeaderIdentity` and `resetUnflushed` are their replacements.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { buildSessionContext, parentOf } from "./context.js";
import { generateEntryId, migrateToCurrentVersion } from "./migrations.js";
import {
  TRANSCRIPT_VERSION,
  type FileEntry,
  type SessionContext,
  type SessionHeader,
  type TranscriptEntry,
  type TranscriptMessage,
  type TreeNode,
} from "./types.js";

const log = createSubsystemLogger("agent/transcript");

/** RFC 9562 UUIDv7 (48-bit ms timestamp + random), lowercase, as pi's session ids. */
export function createSessionId(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Parse a transcript file. Missing file -> []. Blank and unparseable lines are
 * skipped. Returns `{entries, valid}` where `valid` is false when the file has
 * content but its first parsed line is not a session header.
 */
export function loadEntriesFromFile(filePath: string): {
  entries: FileEntry[];
  valid: boolean;
  empty: boolean;
} {
  if (!existsSync(filePath)) {
    return { entries: [], valid: true, empty: true };
  }
  const content = readFileSync(filePath, "utf8");
  if (!content.trim()) {
    return { entries: [], valid: true, empty: true };
  }
  const entries: FileEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      // `null`, numbers and arrays are valid JSON but not entries.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed as FileEntry);
      }
    } catch {
      // skip malformed line
    }
  }
  // The transcript starts at the first valid header. Anything before it (a
  // stray line from another writer, the remains of a damaged file that could
  // not be moved aside) stays on disk and is ignored.
  const headerIndex = entries.findIndex((entry) => {
    const candidate = entry as { type?: unknown; id?: unknown };
    return candidate.type === "session" && typeof candidate.id === "string";
  });
  if (headerIndex === -1) {
    return { entries: [], valid: false, empty: false };
  }
  return {
    entries: headerIndex === 0 ? entries : entries.slice(headerIndex),
    valid: true,
    empty: false,
  };
}

export type TranscriptStoreOptions = {
  cwd: string;
  sessionDir: string;
  sessionFile?: string;
  persist: boolean;
};

export class TranscriptStore {
  /** @internal pi-compatible field names; mutated by session-manager-init.ts until Phase 6. */
  sessionId = "";
  /** @internal */
  fileEntries: FileEntry[] = [];
  /** @internal */
  byId = new Map<string, TranscriptEntry>();
  /** @internal */
  labelsById = new Map<string, string>();
  /** @internal */
  labelTimestampsById = new Map<string, string>();
  /** @internal */
  leafId: string | null = null;
  /** @internal `false` = nothing of `fileEntries` is on disk yet. */
  flushed = false;

  private sessionFile: string | undefined;
  private sessionDir: string;
  private cwd: string;
  private persist: boolean;
  /** Number of leading `fileEntries` already on disk (meaningful while `flushed`). */
  private persistedCount = 0;
  /** Whether the file's last byte has been checked since this instance opened it. */
  private tailChecked = false;

  constructor(options: TranscriptStoreOptions) {
    this.cwd = options.cwd;
    this.sessionDir = options.sessionDir;
    this.persist = options.persist;
    if (this.persist && this.sessionDir && !existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }
    if (options.sessionFile) {
      this.setSessionFile(options.sessionFile);
    } else {
      this.newSession();
    }
  }

  // ── construction ────────────────────────────────────────────────────────

  /** Open (or prepare to create) a transcript at `path`. */
  static open(path: string, sessionDir?: string, cwdOverride?: string): TranscriptStore {
    const loaded = loadEntriesFromFile(path);
    const header = loaded.entries.find((e) => e.type === "session") as SessionHeader | undefined;
    const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
    const dir = sessionDir ?? resolve(path, "..");
    return new TranscriptStore({ cwd, sessionDir: dir, sessionFile: path, persist: true });
  }

  static inMemory(cwd: string = process.cwd()): TranscriptStore {
    return new TranscriptStore({ cwd, sessionDir: "", persist: false });
  }

  setSessionFile(sessionFile: string): void {
    this.sessionFile = resolve(sessionFile);
    const loaded = loadEntriesFromFile(this.sessionFile);
    if (loaded.empty) {
      // Missing or empty: a new session held in memory until the first
      // assistant message (difference 3).
      const explicitPath = this.sessionFile;
      this.newSession();
      this.sessionFile = explicitPath;
      return;
    }
    if (!loaded.valid) {
      // Damaged: move it aside, never overwrite (difference 2).
      const explicitPath = this.sessionFile;
      const aside = `${explicitPath}.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        renameSync(explicitPath, aside);
        log.warn(
          `transcript has no valid session header; moved aside to ${aside} and starting a new session at ${explicitPath}`,
        );
      } catch (err) {
        // If the rename fails we still must not write over the original:
        // fall through with an in-memory session whose flush target is the
        // same path. The first flush appends a header and the entries after
        // the damaged content, and the loader starts at that header.
        log.warn(
          `transcript has no valid session header and could not be moved aside (${String(err)}); appending a new session to ${explicitPath}`,
        );
      }
      this.newSession();
      this.sessionFile = explicitPath;
      return;
    }
    this.fileEntries = loaded.entries;
    const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
    this.sessionId = header?.id ?? createSessionId();
    const migrated = migrateToCurrentVersion(this.fileEntries as Array<Record<string, unknown>>);
    this.buildIndex();
    this.flushed = true;
    this.persistedCount = this.fileEntries.length;
    if (migrated) {
      this.rewriteFile();
    }
  }

  newSession(options?: { id?: string; parentSession?: string }): string | undefined {
    this.sessionId = options?.id ?? createSessionId();
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
      type: "session",
      version: TRANSCRIPT_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: options?.parentSession,
    };
    this.fileEntries = [header];
    this.byId.clear();
    this.labelsById.clear();
    this.leafId = null;
    this.flushed = false;
    this.persistedCount = 0;
    this.tailChecked = false;
    if (this.persist) {
      const fileTimestamp = timestamp.replace(/[:.]/g, "-");
      this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
    }
    return this.sessionFile;
  }

  /**
   * Set the header's identity (our session ids are not uuidv7 and the header
   * records the workspace cwd). Replaces the private mutation in
   * `prepareSessionManagerForRun`. Only valid before anything is on disk.
   */
  setHeaderIdentity(identity: { id: string; cwd?: string }): void {
    const header = this.getHeader();
    if (!header) {
      return;
    }
    header.id = identity.id;
    this.sessionId = identity.id;
    if (identity.cwd !== undefined) {
      header.cwd = identity.cwd;
      this.cwd = identity.cwd;
    }
  }

  // ── persistence ─────────────────────────────────────────────────────────

  private buildIndex(): void {
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    for (const entry of this.fileEntries) {
      if (entry.type === "session") {
        continue;
      }
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      if (entry.type === "label") {
        if (entry.label) {
          this.labelsById.set(entry.targetId, entry.label);
          this.labelTimestampsById.set(entry.targetId, entry.timestamp);
        } else {
          this.labelsById.delete(entry.targetId);
          this.labelTimestampsById.delete(entry.targetId);
        }
      }
    }
  }

  private rewriteFile(): void {
    if (!this.persist || !this.sessionFile) {
      return;
    }
    const content = `${this.fileEntries.map((e) => JSON.stringify(e)).join("\n")}\n`;
    writeFileSync(this.sessionFile, content);
    this.persistedCount = this.fileEntries.length;
  }

  private persistEntries(): void {
    if (!this.persist || !this.sessionFile) {
      return;
    }
    const hasAssistant = this.fileEntries.some(
      (e) => e.type === "message" && e.message.role === "assistant",
    );
    if (!hasAssistant) {
      // Deferred: nothing reaches disk before the first assistant message.
      // (pi also resets `flushed` here, which is the duplicate-header bug.)
      return;
    }
    const from = this.flushed ? Math.min(this.persistedCount, this.fileEntries.length) : 0;
    if (from === 0) {
      mkdirSync(dirname(this.sessionFile), { recursive: true });
    }
    this.closeTornTail();
    if (!this.flushed) {
      this.flushed = true;
      this.persistedCount = 0;
    }
    // Count each entry as it lands, so a write that throws is retried from
    // the entry that failed and not from the start.
    for (let i = from; i < this.fileEntries.length; i++) {
      appendFileSync(this.sessionFile, `${JSON.stringify(this.fileEntries[i])}\n`);
      this.persistedCount = i + 1;
    }
  }

  /**
   * A crash in the middle of an append leaves a last line without a newline.
   * Close it once per instance before appending, or the next entry is glued
   * to the fragment and lost with it.
   */
  private closeTornTail(): void {
    if (this.tailChecked || !this.sessionFile) {
      return;
    }
    this.tailChecked = true;
    let fd: number | undefined;
    try {
      fd = openSync(this.sessionFile, "r");
      const size = fstatSync(fd).size;
      if (size === 0) {
        return;
      }
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) {
        appendFileSync(this.sessionFile, "\n");
      }
    } catch {
      // No file yet: nothing to close.
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  private appendEntry(entry: TranscriptEntry): void {
    // Reject what cannot be written before it becomes part of the session
    // (a BigInt or a cycle in a tool result's details): once in `fileEntries`
    // it would fail every later flush.
    JSON.stringify(entry);
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.persistEntries();
  }

  private nextId(): string {
    return generateEntryId(this.byId);
  }

  // ── appends (key order is the on-disk order) ────────────────────────────

  /** Overridable on purpose: the tool-result guard replaces it on the instance. */
  appendMessage = (message: TranscriptMessage): string => {
    const entry: TranscriptEntry = {
      type: "message",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    this.appendEntry(entry);
    return entry.id;
  };

  appendThinkingLevelChange(thinkingLevel: string): string {
    const entry: TranscriptEntry = {
      type: "thinking_level_change",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: TranscriptEntry = {
      type: "model_change",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
  ): string {
    const entry: TranscriptEntry = {
      type: "compaction",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry = {
      type: "custom",
      customType,
      data,
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    } as TranscriptEntry;
    this.appendEntry(entry);
    return entry.id;
  }

  appendSessionInfo(name: string): string {
    const entry: TranscriptEntry = {
      type: "session_info",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      name: name.trim(),
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: unknown,
    display: boolean,
    details?: T,
  ): string {
    const entry = {
      type: "custom_message",
      customType,
      content,
      display,
      details,
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    } as TranscriptEntry;
    this.appendEntry(entry);
    return entry.id;
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry: TranscriptEntry = {
      type: "label",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    };
    this.appendEntry(entry);
    if (label) {
      this.labelsById.set(targetId, label);
      this.labelTimestampsById.set(targetId, entry.timestamp);
    } else {
      this.labelsById.delete(targetId);
      this.labelTimestampsById.delete(targetId);
    }
    return entry.id;
  }

  // ── reads ───────────────────────────────────────────────────────────────

  isPersisted(): boolean {
    return this.persist;
  }
  getCwd(): string {
    return this.cwd;
  }
  getSessionDir(): string {
    return this.sessionDir;
  }
  getSessionId(): string {
    return this.sessionId;
  }
  getSessionFile(): string | undefined {
    return this.sessionFile;
  }
  getLeafId(): string | null {
    return this.leafId;
  }
  getLeafEntry(): TranscriptEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }
  getEntry(id: string): TranscriptEntry | undefined {
    return this.byId.get(id);
  }
  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  getChildren(parentId: string): TranscriptEntry[] {
    const children: TranscriptEntry[] = [];
    for (const entry of this.byId.values()) {
      if (entry.parentId === parentId) {
        children.push(entry);
      }
    }
    return children;
  }

  /** Root-to-leaf path of all entry types; `[]` when the start is null or unknown. */
  getBranch(fromId?: string): TranscriptEntry[] {
    const path: TranscriptEntry[] = [];
    const startId = fromId ?? this.leafId;
    const seen = new Set<string>();
    let current = startId ? this.byId.get(startId) : undefined;
    let entries: TranscriptEntry[] | undefined;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift(current);
      if (current.parentId && !this.byId.has(current.parentId)) {
        // Damaged file: continue at the previous entry in file order.
        entries ??= this.getEntries();
        current = parentOf(current, this.byId, entries);
      } else {
        current = current.parentId ? this.byId.get(current.parentId) : undefined;
      }
    }
    return path;
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.getEntries(), this.leafId, this.byId);
  }

  getHeader(): SessionHeader | null {
    const header = this.fileEntries.find((e) => e.type === "session");
    return header ? (header as SessionHeader) : null;
  }

  /** Every non-header entry in file order (new array, same entry objects). */
  getEntries(): TranscriptEntry[] {
    return this.fileEntries.filter((e): e is TranscriptEntry => e.type !== "session");
  }

  getSessionName(): string | undefined {
    const entries = this.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.type === "session_info") {
        return entry.name?.trim() || undefined;
      }
    }
    return undefined;
  }

  getTree(): TreeNode[] {
    const entries = this.getEntries();
    const nodeMap = new Map<string, TreeNode>();
    const roots: TreeNode[] = [];
    for (const entry of entries) {
      nodeMap.set(entry.id, {
        entry,
        children: [],
        label: this.labelsById.get(entry.id),
        labelTimestamp: this.labelTimestampsById.get(entry.id),
      });
    }
    for (const entry of entries) {
      const node = nodeMap.get(entry.id)!;
      if (entry.parentId === null || entry.parentId === entry.id) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(entry.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      }
    }
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.children.sort(
        (a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime(),
      );
      stack.push(...node.children);
    }
    return roots;
  }

  // ── branching ───────────────────────────────────────────────────────────

  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
  }

  resetLeaf(): void {
    this.leafId = null;
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
    const entry: TranscriptEntry = {
      type: "branch_summary",
      id: this.nextId(),
      parentId: branchFromId,
      timestamp: new Date().toISOString(),
      fromId: branchFromId ?? "root",
      summary,
      details,
      fromHook,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  /**
   * Turn the path ending at `leafId` into a new session held by this
   * instance. Persisted mode returns the new file path; the file is written
   * only if the path holds an assistant message (otherwise the first
   * assistant append creates it). In-memory mode returns undefined.
   */
  createBranchedSession(leafId: string): string | undefined {
    const previousSessionFile = this.sessionFile;
    const path = this.getBranch(leafId);
    if (path.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }
    const pathWithoutLabels = path.filter((e) => e.type !== "label");
    const newSessionId = createSessionId();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);
    const header: SessionHeader = {
      type: "session",
      version: TRANSCRIPT_VERSION,
      id: newSessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: this.persist ? previousSessionFile : undefined,
    };
    const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
    const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
    for (const [targetId, label] of this.labelsById) {
      if (pathEntryIds.has(targetId)) {
        labelsToWrite.push({
          targetId,
          label,
          timestamp: this.labelTimestampsById.get(targetId) as string,
        });
      }
    }
    const labelEntries: TranscriptEntry[] = [];
    let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
    for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
      const labelEntry: TranscriptEntry = {
        type: "label",
        id: generateEntryId(pathEntryIds),
        parentId,
        timestamp: labelTimestamp,
        targetId,
        label,
      };
      pathEntryIds.add(labelEntry.id);
      labelEntries.push(labelEntry);
      parentId = labelEntry.id;
    }
    this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
    this.sessionId = newSessionId;
    if (!this.persist) {
      this.buildIndex();
      return undefined;
    }
    this.sessionFile = newSessionFile;
    this.buildIndex();
    const hasAssistant = this.fileEntries.some(
      (e) => e.type === "message" && e.message.role === "assistant",
    );
    if (hasAssistant) {
      this.rewriteFile();
      this.flushed = true;
    } else {
      this.flushed = false;
      this.persistedCount = 0;
    }
    return newSessionFile;
  }
}

/** Kept for parity with pi's helper of the same name (used by tests and tools). */
export function newEntryId(): string {
  return randomUUID().slice(0, 8);
}
