import { Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
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
    refresh,
    selectCircle,
    loadMessages,
    loadCards,
    loadDrafts,
    loadOutbound,
    markRead,
    setNotice,
  } = useCirclesStore();
  const [showInvite, setShowInvite] = useState(false);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Inbound (direct dial or mailbox drain) pushes a "circles" event — refresh
  // the active circle immediately instead of waiting for the poll.
  const onCirclesEvent = useCallback(() => {
    if (activeCircleId) {
      void loadMessages(activeCircleId);
      void loadCards(activeCircleId); // a peer's canvas event may have arrived
      void loadDrafts(activeCircleId); // Phase B: an @agent draft may be ready
      void loadOutbound(activeCircleId); // §5.3: an agent write may await approval
      markRead(activeCircleId); // inbound arrived while you're looking at it
    }
    void refresh();
  }, [activeCircleId, loadMessages, loadCards, loadDrafts, loadOutbound, markRead, refresh]);
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
        <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs bg-circle-you-soft/60 text-foreground border-b">
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
              Invite a friend or paste an invite they sent you — your agents connect and the
              conversation starts here.
            </p>
            <button
              type="button"
              onClick={() => setShowInvite(true)}
              className="px-4 py-2 rounded-lg bg-circle-you text-circle-you-fg text-sm"
            >
              Add a friend
            </button>
          </div>
        )}
      </div>

      {showInvite && <InvitePanel onClose={() => setShowInvite(false)} />}
    </div>
  );
}
