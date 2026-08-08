import { Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { cn } from "../../lib/utils";
import { useCirclesStore } from "../../stores/circles-store";
import { CircleChat } from "./CircleChat";
import { CircleRail } from "./CircleRail";
import { CircleRightPane } from "./CircleRightPane";
import { InvitePanel } from "./InvitePanel";

/**
 * PLAN-36 Phase A (redesign): the Circles surface — a Discord/Telegram-style
 * shell (circle rail · chat · member pane) replacing the old PeopleView stats
 * dashboard. Rides the existing circles.* RPCs; the gateway "circles" event
 * nudges a refresh of the active circle so inbound lands without waiting on the
 * 20s poll. Reactions/pins/read-state are the next A-increments; the group
 * canvas (Canvas tab) is Phase C.
 */
export function CirclesView() {
  const {
    status,
    circles,
    activeCircleId,
    loading,
    notice,
    noticeLevel,
    refresh,
    selectCircle,
    loadMessages,
    loadCards,
    loadSandbox,
    loadDrafts,
    loadOutbound,
    loadTab,
    markRead,
    setNotice,
  } = useCirclesStore();
  const [showInvite, setShowInvite] = useState(false);

  // Mount: refresh immediately (CirclesGlobalSync keeps the list warm
  // app-wide on its own 45s cadence).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Whatever circle is ON SCREEN is read — including one AUTO-selected after
  // an archive/delete, which never passes through selectCircle (d638276
  // review #4). Only the mounted view runs this; the background sync never
  // marks anything read.
  useEffect(() => {
    if (activeCircleId) markRead(activeCircleId);
  }, [activeCircleId, markRead]);

  // Inbound (direct dial or mailbox drain) pushes a "circles" event — reload
  // the active circle's panes immediately. (The list refresh rides
  // CirclesGlobalSync's handler for the same event.)
  const onCirclesEvent = useCallback(() => {
    if (activeCircleId) {
      void loadMessages(activeCircleId);
      void loadCards(activeCircleId); // a peer's canvas event may have arrived
      void loadSandbox(activeCircleId); // PLAN-38: a sandbox move may have folded in
      void loadDrafts(activeCircleId); // Phase B: an @agent draft may be ready
      void loadOutbound(activeCircleId); // §5.3: an agent write may await approval
      void loadTab(activeCircleId); // a peer's expense may have landed on the tab
      markRead(activeCircleId); // inbound arrived while you're looking at it
    }
  }, [
    activeCircleId,
    loadMessages,
    loadCards,
    loadSandbox,
    loadDrafts,
    loadOutbound,
    loadTab,
    markRead,
  ]);
  useGatewayEvent("circles", onCirclesEvent);

  if (loading) {
    return <div className="p-8 text-muted-foreground">Loading your circles…</div>;
  }

  if (status && !status.enabled) {
    return (
      <div className="p-8 max-w-lg space-y-3">
        <h1 className="text-xl font-semibold">Circles are off on this node</h1>
        <p className="text-sm text-muted-foreground">
          Circles let your agent connect to friends&apos; agents. Enable them by setting
          <code className="mx-1 px-1 rounded bg-muted">circles.enabled = true</code> in your config.
        </p>
      </div>
    );
  }

  const activeCircle = circles.find((c) => c.circleId === activeCircleId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {notice && (
        <div
          role={noticeLevel === "error" ? "alert" : "status"}
          className={cn(
            "flex items-center justify-between gap-3 px-4 py-2 text-xs border-b",
            // Phase D: a failed send must not look like a friendly tip.
            noticeLevel === "error"
              ? "bg-destructive/10 text-destructive border-destructive/30"
              : "bg-circle-you-soft/60 text-foreground",
          )}
        >
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="underline shrink-0">
            dismiss
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <CircleRail
          circles={circles}
          activeCircleId={activeCircleId}
          onSelect={selectCircle}
          onAdd={() => setShowInvite(true)}
        />

        {activeCircle ? (
          <>
            <CircleChat
              key={activeCircle.circleId}
              circle={activeCircle}
              selfPubkey={status?.pubkey}
            />
            <CircleRightPane circle={activeCircle} selfPubkey={status?.pubkey} />
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
            <Users className="w-10 h-10 text-muted-foreground" />
            <h2 className="text-lg font-semibold">No circles yet</h2>
            <p className="text-sm text-muted-foreground max-w-xs">
              Start a circle and invite a friend — or paste an invite they sent you. Your agents
              connect and the conversation starts here.
            </p>
            <button
              type="button"
              onClick={() => setShowInvite(true)}
              className="px-4 py-2 rounded-lg bg-circle-you text-circle-you-fg text-sm"
            >
              Start a circle
            </button>
          </div>
        )}
      </div>

      {showInvite && <InvitePanel onClose={() => setShowInvite(false)} />}
    </div>
  );
}
