import type { Circle } from "../../stores/circles-store";
import { cn } from "../../lib/utils";

// PLAN-36 Phase A: the member/presence roster (inner content of the right pane;
// the pane's tabs live in CircleRightPane). Agent posture per member becomes
// live in Phase B; for now every agent shows the enforced default: summon-only.

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
  return (
    <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
      {circle.members.map((m) => {
        const name = m.isSelf ? "You" : (m.displayName ?? "friend");
        const st = statusOf(m.lastSeenAt, m.lastStatus);
        return (
          <div key={m.memberPubkey} className="flex items-center gap-2.5 text-[13px]">
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
            <span className="ml-auto text-[11px] text-muted-foreground">agent: summon-only</span>
          </div>
        );
      })}
    </div>
  );
}
