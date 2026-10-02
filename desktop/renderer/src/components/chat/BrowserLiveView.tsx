import { Globe, Hand, MonitorOff, MousePointerClick, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useBrowserLive } from "../../hooks/useBrowserLive";
import {
  buttonName,
  keyInput,
  modifiersOf,
  pointOnPage,
  type LiveInputEvent,
} from "../../lib/browser-live-input";
import { cn } from "../../lib/utils";
import { useBrowserLiveStore, type BrowserLiveFrame } from "../../stores/browser-live-store";
import { extractDomain } from "./tool-views/tool-view-utils";

/** Pointer moves are a stream; this many per second is plenty to hover and drag. */
const MOVE_INTERVAL_MS = 33;

/**
 * The agent's real browser, streamed from the gateway (PLAN-53 A2), with a
 * take-over so a person can drive it for a login or a CAPTCHA (A3). While a
 * person has control the agent's page-driving actions are held.
 */
export function BrowserLiveView({ className }: { className?: string }) {
  const { state, reason, url, title, frame, control, mine } = useBrowserLive(true);
  const takeControl = useBrowserLiveStore((s) => s.takeControl);
  const handBack = useBrowserLiveStore((s) => s.handBack);
  const streaming = state === "streaming";
  const showing = streaming && frame !== null;

  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-b border-border/30">
        <Globe className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        <div
          className="flex-1 text-2xs font-mono text-muted-foreground truncate"
          title={url ?? undefined}
          data-testid="browser-live-url"
        >
          {url ?? "about:blank"}
        </div>
        {url && (
          <span className="text-3xs text-muted-foreground flex-shrink-0">{extractDomain(url)}</span>
        )}
        <LiveBadge streaming={showing} />
        {showing && control === "agent" && (
          <button
            onClick={() => void takeControl()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
          >
            <MousePointerClick className="w-3.5 h-3.5" />
            Take over
          </button>
        )}
        {showing && control === "user" && (
          <button
            onClick={() => void handBack()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-brand border border-brand/20 bg-brand/10 hover:bg-brand/15 transition-colors flex-shrink-0"
          >
            <Hand className="w-3.5 h-3.5" />
            Hand back
          </button>
        )}
      </div>

      {showing && control === "user" && (
        <div className="px-3 py-1.5 text-xs bg-warning/10 text-warning border-b border-warning/20">
          {mine
            ? "You are in control. The agent cannot act on this page until you hand it back."
            : "Another window has control of this browser. The agent is waiting."}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto bg-card/60 flex items-start justify-center">
        {frame && streaming ? (
          <LiveSurface frame={frame} title={title} interactive={mine} />
        ) : (
          <LiveViewNotice state={state} reason={reason} />
        )}
      </div>
    </div>
  );
}

/** The page image. When `interactive`, pointer and keyboard go to the page. */
function LiveSurface({
  frame,
  title,
  interactive,
}: {
  frame: BrowserLiveFrame;
  title?: string;
  interactive: boolean;
}) {
  const sendInput = useBrowserLiveStore((s) => s.sendInput);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const lastMoveAt = useRef(0);
  // Read through a ref so the native wheel listener never goes stale.
  const pageSize = useRef({ width: 0, height: 0 });
  pageSize.current = {
    width: frame.deviceWidth || imgRef.current?.naturalWidth || 0,
    height: frame.deviceHeight || imgRef.current?.naturalHeight || 0,
  };

  const pointAt = useCallback((e: { clientX: number; clientY: number }) => {
    const img = imgRef.current;
    return img ? pointOnPage(e, img.getBoundingClientRect(), pageSize.current) : null;
  }, []);

  const mouse = (type: "down" | "up" | "move", e: React.MouseEvent) => {
    if (!interactive) {
      return;
    }
    if (type === "move") {
      const now = performance.now();
      if (now - lastMoveAt.current < MOVE_INTERVAL_MS) {
        return;
      }
      lastMoveAt.current = now;
    }
    const point = pointAt(e);
    if (!point) {
      return;
    }
    if (type === "down") {
      // Keys go to whatever has focus; make that the page surface.
      surfaceRef.current?.focus();
    }
    e.preventDefault();
    sendInput({
      kind: "mouse",
      type,
      ...point,
      button: type === "move" && e.buttons === 0 ? undefined : buttonName(e.button),
      buttons: e.buttons,
      clickCount: type === "move" ? undefined : Math.max(1, e.detail),
      modifiers: modifiersOf(e),
    });
  };

  const key = (type: "down" | "up", e: React.KeyboardEvent) => {
    if (!interactive) {
      return;
    }
    // Paste arrives as its own event with the text; do not also send Ctrl+V.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      return;
    }
    // Otherwise Tab would leave the page and Space would scroll the pane.
    e.preventDefault();
    sendInput(keyInput(type, e.nativeEvent));
  };

  // React registers wheel listeners as passive, so preventDefault is ignored
  // there and the pane would scroll along with the page. Attach natively.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || !interactive) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      const point = pointAt(e);
      if (!point) {
        return;
      }
      e.preventDefault();
      const event: LiveInputEvent = {
        kind: "wheel",
        ...point,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        modifiers: modifiersOf(e),
      };
      sendInput(event);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [interactive, pointAt, sendInput]);

  return (
    <div
      ref={surfaceRef}
      tabIndex={interactive ? 0 : undefined}
      data-testid="browser-live-surface"
      className={cn(
        "w-full outline-none",
        interactive && "cursor-crosshair ring-1 ring-warning/40",
      )}
      onMouseDown={(e) => mouse("down", e)}
      onMouseUp={(e) => mouse("up", e)}
      onMouseMove={(e) => mouse("move", e)}
      onContextMenu={(e) => interactive && e.preventDefault()}
      onKeyDown={(e) => key("down", e)}
      onKeyUp={(e) => key("up", e)}
      onPaste={(e) => {
        if (!interactive) {
          return;
        }
        const text = e.clipboardData.getData("text");
        if (text) {
          e.preventDefault();
          sendInput({ kind: "text", text });
        }
      }}
    >
      <img
        ref={imgRef}
        src={frame.src}
        alt={title ? `Agent's browser: ${title}` : "Agent's browser"}
        className="w-full h-auto object-contain select-none"
        draggable={false}
      />
    </div>
  );
}

function LiveBadge({ streaming }: { streaming: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-full border flex-shrink-0",
        streaming ? "bg-success/10 border-success/20" : "bg-muted/10 border-border/20",
      )}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          streaming ? "bg-success animate-pulse" : "bg-muted",
        )}
      />
      <span
        className={cn(
          "text-badge font-medium",
          streaming ? "text-success" : "text-muted-foreground",
        )}
      >
        {streaming ? "Live" : "Not live"}
      </span>
    </div>
  );
}

function LiveViewNotice({ state, reason }: { state: string; reason?: string }) {
  const waiting = state === "connecting" || state === "streaming" || state === "off";
  const heading =
    state === "idle"
      ? "The browser is not open"
      : state === "unavailable"
        ? "Live view is not available"
        : "Connecting to the browser";
  const detail =
    state === "idle"
      ? "It will appear here as soon as the agent opens a page."
      : state === "unavailable"
        ? reason
        : "Waiting for the first frame.";
  return (
    <div className="self-center text-center space-y-2 text-muted-foreground px-6 py-10">
      {waiting ? (
        <RotateCw className="w-7 h-7 mx-auto opacity-50 animate-spin" />
      ) : (
        <MonitorOff className="w-7 h-7 mx-auto opacity-50" />
      )}
      <p className="text-sm">{heading}</p>
      {detail && <p className="text-xs">{detail}</p>}
    </div>
  );
}
