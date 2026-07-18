import { UserMinus } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { useCirclesStore, type Circle } from "../../stores/circles-store";

// PLAN-36 Phase A: the member/presence roster (inner content of the right pane;
// the pane's tabs live in CircleRightPane). §5.5: ANY member can remove another
// from their OWN node — a two-tap prune that default-denies the removed member's
// writes on THIS node (node-local self-protection; there is no central authority
// in a P2P circle, so each member decides for their own node).

const ONLINE_WINDOW_MS = 10 * 60_000;

function statusOf(lastSeenAt: number | null, lastStatus: string | null): "on" | "idle" | "off" {
  if (!lastSeenAt || Date.now() - lastSeenAt > ONLINE_WINDOW_MS) return "off";
  return lastStatus === "online" ? "on" : "idle";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return ((parts[0] as string)[0] + (parts[1] as string)[0]).toUpperCase();
}

export function CircleMembers({ circle }: { circle: Circle }) {
  const removeMember = useCirclesStore((s) => s.removeMember);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Any member may prune their own node's roster; only in an active circle.
  const canModerate = circle.status === "active";

  const remove = async (memberPubkey: string) => {
    if (busy) return;
    setBusy(true);
    await removeMember(circle.circleId, memberPubkey);
    setBusy(false);
    setConfirming(null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
      {circle.members.map((m) => {
        const name = m.isSelf ? "You" : (m.displayName ?? "friend");
        const st = statusOf(m.lastSeenAt, m.lastStatus);
        const removable = canModerate && !m.isSelf;
        return (
          <div key={m.memberPubkey} className="group flex flex-col gap-1">
            <div className="flex items-center gap-2.5 text-[13px]">
              <div className="relative shrink-0">
                <div
                  className="w-6 h-6 rounded-lg grid place-items-center text-[11px] font-bold text-white"
                  style={{ background: m.isSelf ? "#3a5bd9" : "#0f9d68" }}
                >
                  {initials(name)}
                </div>
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card",
                    st === "on" && "bg-green-500",
                    st === "idle" && "bg-amber-500",
                    st === "off" && "bg-muted-foreground",
                  )}
                />
              </div>
              <span className="font-semibold">{name}</span>
              {m.role === "creator" && (
                <span className="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
                  creator
                </span>
              )}
              <span className="ml-auto text-[11px] text-muted-foreground">agent: summon-only</span>
              {removable && confirming !== m.memberPubkey && (
                <button
                  type="button"
                  onClick={() => setConfirming(m.memberPubkey)}
                  aria-label={`Remove ${name}`}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-destructive p-0.5 rounded"
                >
                  <UserMinus className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {removable && confirming === m.memberPubkey && (
              <div className="ml-8 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[11px] space-y-1.5">
                <p className="text-muted-foreground">
                  Remove <span className="font-medium text-foreground">{name}</span>? Their writes
                  stop reaching this node. This only affects{" "}
                  <span className="font-medium">your</span> node — ask the others to remove them
                  too.
                </p>
                <div className="flex items-center gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="text-muted-foreground px-2 py-0.5"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(m.memberPubkey)}
                    disabled={busy}
                    className="font-medium px-2 py-0.5 rounded bg-destructive text-destructive-foreground disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
