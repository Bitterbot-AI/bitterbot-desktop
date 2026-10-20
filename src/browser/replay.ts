/**
 * Session replay for the agent's browser (PLAN-53 A6).
 *
 * Live view only streams while someone is watching. This keeps a low-rate
 * record regardless: one JPEG after each page-changing browser action, at
 * most one every REPLAY_MIN_GAP_MS per session, so the owner can see later
 * what the agent did on a site. Frames stay on this machine under
 * `<state>/replays/<session>/`, owner-readable only, and are pruned by age
 * and count.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { cardEntryActive } from "./card-entry.js";

export const REPLAY_MIN_GAP_MS = 1_500;
export const REPLAY_MAX_FRAMES_PER_SESSION = 300;
export const REPLAY_DEFAULT_RETENTION_DAYS = 7;

/** Browser actions after which the page may look different. */
export const REPLAY_ACTIONS: ReadonlySet<string> = new Set([
  "open",
  "navigate",
  "act",
  "upload",
  "dialog",
  "focus",
]);

export type ReplayFrame = {
  ts: number;
  file: string;
  action: string;
  url?: string;
  title?: string;
};

export type ReplaySession = {
  id: string;
  sessionKey: string;
  frames: number;
  firstTs: number;
  lastTs: number;
};

export function replayRoot(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "replays");
}

/** A filesystem-safe, stable folder name for a session key. */
export function replaySessionId(sessionKey: string): string {
  const slug = sessionKey
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 10);
  return `${slug || "session"}-${hash}`;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const FRAME_FILE_RE = /^\d{13}-\d{1,6}\.jpg$/;

function readIndex(dir: string): ReplayFrame[] {
  try {
    return fs
      .readFileSync(path.join(dir, "index.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ReplayFrame];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function readMeta(dir: string): { sessionKey?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")) as {
      sessionKey?: string;
    };
  } catch {
    return {};
  }
}

export type ReplayRecorderDeps = {
  /** Capture the current page as JPEG bytes, or null when there is nothing to capture. */
  capture: (opts: {
    targetId?: string;
    profile?: string;
    baseUrl?: string;
  }) => Promise<Buffer | null>;
  stateDir?: string;
  now?: () => number;
  retentionDays?: () => number;
  enabled?: () => boolean;
};

export function createReplayRecorder(deps: ReplayRecorderDeps) {
  const now = deps.now ?? Date.now;
  const lastAt = new Map<string, number>();
  const inFlight = new Set<string>();
  let seq = 0;
  let lastPrune = 0;

  const root = () => replayRoot(deps.stateDir);

  function prune(at: number): void {
    if (at - lastPrune < 60 * 60 * 1000) {
      return;
    }
    lastPrune = at;
    const days = deps.retentionDays?.() ?? REPLAY_DEFAULT_RETENTION_DAYS;
    const cutoff = at - days * 24 * 60 * 60 * 1000;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root());
    } catch {
      return;
    }
    for (const id of entries) {
      const dir = path.join(root(), id);
      const frames = readIndex(dir);
      const last = frames.at(-1)?.ts ?? 0;
      if (last < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  /** Keep the newest frames; drop files beyond the cap. */
  function cap(dir: string, frames: ReplayFrame[]): void {
    if (frames.length <= REPLAY_MAX_FRAMES_PER_SESSION) {
      return;
    }
    const drop = frames.slice(0, frames.length - REPLAY_MAX_FRAMES_PER_SESSION);
    for (const f of drop) {
      fs.rmSync(path.join(dir, f.file), { force: true });
    }
    const keep = frames.slice(drop.length);
    fs.writeFileSync(
      path.join(dir, "index.jsonl"),
      keep.map((f) => JSON.stringify(f)).join("\n") + "\n",
      { mode: 0o600 },
    );
  }

  /**
   * Record one frame for a session after a browser action. Never throws and
   * never blocks the tool: callers fire and forget.
   */
  async function record(params: {
    sessionKey: string;
    action: string;
    targetId?: string;
    profile?: string;
    /** Browser control server the action went to (sandbox or host). */
    baseUrl?: string;
    url?: string;
    title?: string;
  }): Promise<ReplayFrame | null> {
    if (deps.enabled && !deps.enabled()) {
      return null;
    }
    if (!REPLAY_ACTIONS.has(params.action)) {
      return null;
    }
    // A card was just typed into the page: it must not end up on disk.
    if (cardEntryActive(now())) {
      return null;
    }
    const id = replaySessionId(params.sessionKey);
    const at = now();
    if (inFlight.has(id) || at - (lastAt.get(id) ?? 0) < REPLAY_MIN_GAP_MS) {
      return null;
    }
    inFlight.add(id);
    lastAt.set(id, at);
    try {
      const jpeg = await deps.capture({
        targetId: params.targetId,
        profile: params.profile,
        baseUrl: params.baseUrl,
      });
      if (!jpeg || jpeg.length === 0) {
        return null;
      }
      const dir = path.join(root(), id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(path.join(dir, "session.json"))) {
        fs.writeFileSync(
          path.join(dir, "session.json"),
          JSON.stringify({ sessionKey: params.sessionKey }),
          { mode: 0o600 },
        );
      }
      seq = (seq + 1) % 1_000_000;
      const ts = now();
      const frame: ReplayFrame = {
        ts,
        file: `${String(ts).padStart(13, "0")}-${seq}.jpg`,
        action: params.action,
        ...(params.url ? { url: params.url } : {}),
        ...(params.title ? { title: params.title.slice(0, 200) } : {}),
      };
      fs.writeFileSync(path.join(dir, frame.file), jpeg, { mode: 0o600 });
      fs.appendFileSync(path.join(dir, "index.jsonl"), `${JSON.stringify(frame)}\n`, {
        mode: 0o600,
      });
      cap(dir, readIndex(dir));
      prune(ts);
      return frame;
    } catch {
      return null;
    } finally {
      inFlight.delete(id);
    }
  }

  return { record };
}

export type ReplayRecorder = ReturnType<typeof createReplayRecorder>;

// ── Reading (gateway RPC) ────────────────────────────────────────────────────

export function listReplaySessions(stateDir?: string): ReplaySession[] {
  const root = replayRoot(stateDir);
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(root).filter((id) => SESSION_ID_RE.test(id));
  } catch {
    return [];
  }
  return ids
    .flatMap((id) => {
      const frames = readIndex(path.join(root, id));
      const sessionKey = readMeta(path.join(root, id)).sessionKey;
      if (frames.length === 0 || !sessionKey) {
        return [];
      }
      return [
        {
          id,
          sessionKey,
          frames: frames.length,
          firstTs: frames[0].ts,
          lastTs: frames.at(-1)!.ts,
        },
      ];
    })
    .toSorted((a, b) => b.lastTs - a.lastTs);
}

export function listReplayFrames(
  id: string,
  opts: { from?: number; to?: number; stateDir?: string } = {},
): ReplayFrame[] {
  if (!SESSION_ID_RE.test(id)) {
    return [];
  }
  return readIndex(path.join(replayRoot(opts.stateDir), id)).filter(
    (f) => (opts.from == null || f.ts >= opts.from) && (opts.to == null || f.ts <= opts.to),
  );
}

/** One frame's bytes, or null. Both names are validated; no path escapes the replay folder. */
export function readReplayFrame(id: string, file: string, stateDir?: string): Buffer | null {
  if (!SESSION_ID_RE.test(id) || !FRAME_FILE_RE.test(file)) {
    return null;
  }
  try {
    return fs.readFileSync(path.join(replayRoot(stateDir), id, file));
  } catch {
    return null;
  }
}

export function deleteReplaySession(id: string, stateDir?: string): boolean {
  if (!SESSION_ID_RE.test(id)) {
    return false;
  }
  const dir = path.join(replayRoot(stateDir), id);
  if (!fs.existsSync(dir)) {
    return false;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
