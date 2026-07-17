import { Plus } from "lucide-react";
import type { Circle } from "../../stores/circles-store";
import { cn } from "../../lib/utils";

// PLAN-36 Phase A: the left circle rail. One tile per circle; the "+" opens the
// invite/join modal. Unread badges land in A2 (circle_read_state).

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return ((parts[0] as string)[0] + (parts[1] as string)[0]).toUpperCase();
}

interface Props {
  circles: Circle[];
  activeCircleId: string | null;
  onSelect: (circleId: string) => void;
  onAdd: () => void;
}

export function CircleRail({ circles, activeCircleId, onSelect, onAdd }: Props) {
  return (
    <nav
      className="w-[60px] shrink-0 border-r bg-muted/40 flex flex-col items-center gap-2.5 py-3"
      aria-label="Your circles"
    >
      {circles.map((c) => {
        const active = c.circleId === activeCircleId;
        return (
          <button
            key={c.circleId}
            type="button"
            onClick={() => onSelect(c.circleId)}
            title={c.name}
            aria-label={c.name}
            aria-current={active ? "true" : undefined}
            className={cn(
              "w-10 h-10 grid place-items-center text-[13px] font-bold text-white transition-all",
              active
                ? "rounded-[15px] ring-2 ring-primary ring-offset-2 ring-offset-muted/40"
                : "rounded-[13px]",
            )}
            style={{ background: "linear-gradient(135deg,#6a3ecf,#3a5bd9)" }}
          >
            {initials(c.name)}
          </button>
        );
      })}
      <div className="w-6 h-px bg-border" />
      <button
        type="button"
        onClick={onAdd}
        aria-label="Add a friend"
        title="Add a friend"
        className="w-10 h-10 rounded-[13px] grid place-items-center border border-dashed text-muted-foreground hover:text-foreground hover:border-primary"
      >
        <Plus className="w-5 h-5" />
      </button>
    </nav>
  );
}
