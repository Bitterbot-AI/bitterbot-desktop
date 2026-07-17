import type { Circle } from "../../stores/circles-store";
import { cn } from "../../lib/utils";

// PLAN-36 Phase A: the right pane — the member/presence roster. The "Canvas"
// tab is stubbed (Phase C: the group canvas of collective agent output). Agent
// posture per member ("listening"/"summon-only") becomes live in Phase B; for
// now every agent shows the enforced default: summon-only.

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
    <aside className="w-[280px] shrink-0 border-l bg-card flex flex-col">
      <div className="flex gap-1 px-3 pt-2.5 border-b">
        <span className="text-xs font-semibold px-2.5 py-1.5 rounded-t-lg bg-muted text-foreground shadow-[inset_0_-2px_0_var(--primary)]">
          Members
        </span>
        <span
          className="text-xs font-semibold px-2.5 py-1.5 text-muted-foreground/50 cursor-not-allowed"
          title="Coming in Phase C: the shared canvas of collective agent output"
        >
          Canvas
        </span>
      </div>

      <div className="p-3 flex flex-col gap-2.5 overflow-y-auto">
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
    </aside>
  );
}
