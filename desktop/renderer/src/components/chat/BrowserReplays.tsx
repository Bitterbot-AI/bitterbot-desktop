import { ChevronLeft, ChevronRight, Film, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { describeError } from "../../lib/describe-error";
import { useGatewayStore } from "../../stores/gateway-store";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

export type ReplaySession = {
  id: string;
  sessionKey: string;
  frames: number;
  firstTs: number;
  lastTs: number;
};

export type ReplayFrame = { ts: number; file: string; action: string; url?: string };

/** The frame nearest a moment, for opening a recording at an activity item. */
export function nearestFrameIndex(frames: ReplayFrame[], ts: number): number {
  let best = 0;
  for (let i = 1; i < frames.length; i++) {
    if (Math.abs(frames[i].ts - ts) < Math.abs(frames[best].ts - ts)) best = i;
  }
  return best;
}

/** A readable name for a session key: the channel part after the agent. */
export function describeSession(sessionKey: string): string {
  const parts = sessionKey.split(":");
  return parts.length > 2 ? parts.slice(2).join(" · ") : sessionKey;
}

/**
 * What the agent's browser showed, recorded after each page action
 * (PLAN-53 A6). Shown only when there is a recording.
 */
export function BrowserReplays({
  sessions,
  onOpen,
  onDeleted,
}: {
  sessions: ReplaySession[];
  onOpen: (s: ReplaySession) => void;
  onDeleted: (id: string) => void;
}) {
  const request = useGatewayStore((s) => s.request);
  if (sessions.length === 0) return null;
  return (
    <details className="border-b border-border/30" data-testid="activity-replays">
      <summary className="px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer">
        Browser recordings ({sessions.length})
      </summary>
      <ul className="divide-y divide-border/20">
        {sessions.map((s) => (
          <li key={s.id} className="px-3 py-1.5 flex items-center gap-2">
            <button
              onClick={() => onOpen(s)}
              className="flex-1 min-w-0 text-left flex items-center gap-2 hover:text-foreground"
            >
              <Film className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
              <span className="text-xs truncate">{describeSession(s.sessionKey)}</span>
              <span className="text-2xs text-muted-foreground flex-shrink-0">
                {s.frames} frames · {new Date(s.lastTs).toLocaleString()}
              </span>
            </button>
            <button
              aria-label="Delete recording"
              onClick={() =>
                void request("browser.replay.delete", { id: s.id })
                  .then(() => onDeleted(s.id))
                  .catch((err) =>
                    toast.error("Could not delete it", { description: describeError(err) }),
                  )
              }
              className="p-1 text-muted-foreground hover:text-danger"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Steps through a recording one frame at a time. */
export function ReplayPlayer({
  session,
  at,
  onClose,
}: {
  session: ReplaySession | null;
  /** Open at the frame nearest this time. */
  at?: number;
  onClose: () => void;
}) {
  const request = useGatewayStore((s) => s.request);
  const [frames, setFrames] = useState<ReplayFrame[]>([]);
  const [index, setIndex] = useState(0);
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    setFrames([]);
    setImage(null);
    void (
      request("browser.replay.frames", { id: session.id }) as Promise<{
        frames: ReplayFrame[];
      }>
    )
      .then((res) => {
        const list = res.frames ?? [];
        setFrames(list);
        setIndex(at != null ? nearestFrameIndex(list, at) : Math.max(list.length - 1, 0));
      })
      .catch((err) => toast.error("Could not load it", { description: describeError(err) }));
  }, [session, at, request]);

  const frame = frames[index];
  const loadImage = useCallback(async () => {
    if (!session || !frame) return;
    try {
      const res = (await request("browser.replay.frame", { id: session.id, file: frame.file })) as {
        data: string;
        mimeType: string;
      };
      setImage(`data:${res.mimeType};base64,${res.data}`);
    } catch {
      setImage(null);
    }
  }, [session, frame, request]);

  useEffect(() => {
    void loadImage();
  }, [loadImage]);

  return (
    <Dialog open={session !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Browser recording</DialogTitle>
          <DialogDescription>
            {session ? describeSession(session.sessionKey) : ""}
            {frame ? ` · ${new Date(frame.ts).toLocaleString()} · after ${frame.action}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="rounded-lg border border-border/30 bg-black/80 flex items-center justify-center min-h-[240px]">
            {image ? (
              <img src={image} alt="What the agent's browser showed" className="max-h-[60vh]" />
            ) : (
              <span className="text-xs text-muted-foreground">
                {frames.length === 0 ? "No frames." : "Loading…"}
              </span>
            )}
          </div>
          {frame?.url && <p className="text-2xs text-muted-foreground truncate">{frame.url}</p>}
          <div className="flex items-center gap-2">
            <button
              aria-label="Previous frame"
              disabled={index <= 0}
              onClick={() => setIndex((i) => Math.max(i - 1, 0))}
              className="p-1 rounded disabled:opacity-30"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(frames.length - 1, 0)}
              value={index}
              onChange={(e) => setIndex(Number(e.target.value))}
              aria-label="Frame"
              className="flex-1"
            />
            <button
              aria-label="Next frame"
              disabled={index >= frames.length - 1}
              onClick={() => setIndex((i) => Math.min(i + 1, frames.length - 1))}
              className="p-1 rounded disabled:opacity-30"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="text-2xs text-muted-foreground w-16 text-right">
              {frames.length > 0 ? `${index + 1} / ${frames.length}` : ""}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
