import { useEffect, useState } from "react";
import type { Circle } from "../../stores/circles-store";
import { cn } from "../../lib/utils";
import { CircleCanvas } from "./CircleCanvas";
import { CircleMembers } from "./CircleMembers";

// PLAN-36 Phase C1: the right pane now really switches between the member
// roster and the group Canvas (was a stubbed tab). A card count badges the
// Canvas tab so activity is visible without switching. The pane is resizable
// (drag its left edge; double-click the handle to reset) — the members roster
// and especially the Canvas need room; the width persists across sessions.

type Tab = "members" | "canvas";

const MIN_WIDTH = 260;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 570; // 90% wider than the original 300px
const WIDTH_KEY = "circles.rightPaneWidth";

function readStoredWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) return saved;
  } catch {
    /* localStorage unavailable — fall through to default */
  }
  return DEFAULT_WIDTH;
}

export function CircleRightPane({
  circle,
  selfPubkey,
  cardCount,
}: {
  circle: Circle;
  selfPubkey: string | undefined;
  cardCount: number;
}) {
  const [tab, setTab] = useState<Tab>("members");
  const [width, setWidth] = useState<number>(readStoredWidth);

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* ignore persistence failure */
    }
  }, [width]);

  // Drag the left-edge handle to resize; the pane is on the RIGHT, so dragging
  // LEFT (clientX decreasing) widens it.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (startX - ev.clientX)));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none"; // no text selection while dragging
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <aside style={{ width }} className="relative shrink-0 border-l bg-card flex flex-col min-h-0">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize pane"
        onMouseDown={startResize}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        title="Drag to resize · double-click to reset"
        className="absolute left-0 top-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize z-10 hover:bg-primary/40"
      />
      <div className="flex gap-1 px-3 pt-2.5 border-b">
        <button
          type="button"
          onClick={() => setTab("members")}
          className={cn(
            "text-xs font-semibold px-2.5 py-1.5 rounded-t-lg",
            tab === "members"
              ? "bg-muted text-foreground shadow-[inset_0_-2px_0_var(--primary)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Members
        </button>
        <button
          type="button"
          onClick={() => setTab("canvas")}
          className={cn(
            "text-xs font-semibold px-2.5 py-1.5 rounded-t-lg flex items-center gap-1.5",
            tab === "canvas"
              ? "bg-muted text-foreground shadow-[inset_0_-2px_0_var(--primary)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Canvas
          {cardCount > 0 && (
            <span className="text-[10px] font-bold rounded-full bg-primary/15 text-primary px-1.5 min-w-[16px] text-center">
              {cardCount}
            </span>
          )}
        </button>
      </div>

      {tab === "members" ? (
        <CircleMembers circle={circle} />
      ) : (
        <CircleCanvas circle={circle} selfPubkey={selfPubkey} />
      )}
    </aside>
  );
}
