import { useEffect, useState } from "react";
import type { Circle } from "../../stores/circles-store";
import { CircleCanvas } from "./CircleCanvas";
import { CircleMembers } from "./CircleMembers";

// The right pane STACKS the member roster (top, its own scroll, capped) over
// the always-visible group Canvas (bottom, takes the rest) — the canvas is
// where things stop scrolling away, so it must never hide behind a tab
// (2026-07-25 direction). The pane is resizable (drag its left edge;
// double-click the handle to reset); the width persists across sessions.

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
}: {
  circle: Circle;
  selfPubkey: string | undefined;
}) {
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
        className="absolute left-0 top-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize z-10 hover:bg-circle-you/40"
      />
      {/* Roster on top: scrolls internally, never starves the canvas. */}
      <div className="shrink-0 max-h-[38%] overflow-y-auto border-b">
        <CircleMembers circle={circle} />
      </div>
      {/* The canvas is ALWAYS visible below the people it belongs to. */}
      <CircleCanvas circle={circle} selfPubkey={selfPubkey} />
    </aside>
  );
}
