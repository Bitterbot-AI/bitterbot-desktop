import { useState } from "react";
import type { Circle } from "../../stores/circles-store";
import { cn } from "../../lib/utils";
import { CircleCanvas } from "./CircleCanvas";
import { CircleMembers } from "./CircleMembers";

// PLAN-36 Phase C1: the right pane now really switches between the member
// roster and the group Canvas (was a stubbed tab). A card count badges the
// Canvas tab so activity is visible without switching.

type Tab = "members" | "canvas";

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

  return (
    <aside className="w-[300px] shrink-0 border-l bg-card flex flex-col min-h-0">
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
