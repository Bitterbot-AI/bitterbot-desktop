import { Archive, ArchiveRestore, MoreVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { useCirclesStore, type Circle } from "../../stores/circles-store";

// PLAN-36 Phase A: the left circle rail. One tile per circle; the "+" opens the
// invite/join modal. Hovering a tile reveals a "⋯" menu to Archive (reversible
// hide) or Delete (permanent, node-local) the circle, each behind a confirm.

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return ((parts[0] as string)[0] + (parts[1] as string)[0]).toUpperCase();
}

type Step = "menu" | "confirm-archive" | "confirm-delete";

interface Props {
  circles: Circle[];
  activeCircleId: string | null;
  onSelect: (circleId: string) => void;
  onAdd: () => void;
}

export function CircleRail({ circles, activeCircleId, onSelect, onAdd }: Props) {
  const archiveCircle = useCirclesStore((s) => s.archiveCircle);
  const unarchiveCircle = useCirclesStore((s) => s.unarchiveCircle);
  const deleteCircle = useCirclesStore((s) => s.deleteCircle);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("menu");
  const [busy, setBusy] = useState(false);

  const openMenu = (circleId: string) => {
    setMenuFor(circleId);
    setStep("menu");
  };
  const close = () => {
    setMenuFor(null);
    setStep("menu");
  };

  const act = async (fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    await fn();
    setBusy(false);
    close();
  };

  return (
    <nav
      className="w-[60px] shrink-0 border-r bg-muted/40 flex flex-col items-center gap-2.5 py-3"
      aria-label="Your circles"
    >
      {circles.map((c) => {
        const active = c.circleId === activeCircleId;
        const unread = c.unread ?? 0;
        const archived = c.status === "archived";
        return (
          <div key={c.circleId} className="group relative">
            <button
              type="button"
              onClick={() => onSelect(c.circleId)}
              title={archived ? `${c.name} (archived)` : c.name}
              aria-label={unread > 0 ? `${c.name}, ${unread} unread` : c.name}
              aria-current={active ? "true" : undefined}
              className={cn(
                "w-10 h-10 grid place-items-center text-[13px] font-bold text-white transition-all",
                active
                  ? "rounded-[15px] ring-2 ring-circle-you ring-offset-2 ring-offset-muted/40"
                  : "rounded-[13px]",
                archived && "opacity-40 grayscale",
              )}
              style={{ background: "linear-gradient(135deg,#6a3ecf,#3a5bd9)" }}
            >
              {initials(c.name)}
            </button>

            {unread > 0 && !active && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold grid place-items-center border-2 border-muted/40">
                {unread > 99 ? "99+" : unread}
              </span>
            )}

            {/* Hover-reveal menu trigger. */}
            <button
              type="button"
              onClick={() => openMenu(c.circleId)}
              aria-label={`${c.name} options`}
              className={cn(
                "absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-card border grid place-items-center text-muted-foreground hover:text-foreground shadow-sm",
                menuFor === c.circleId
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 focus:opacity-100",
              )}
            >
              <MoreVertical className="w-2.5 h-2.5" />
            </button>

            {menuFor === c.circleId && (
              <>
                {/* click-outside backdrop */}
                <div className="fixed inset-0 z-40" onClick={close} aria-hidden="true" />
                <div className="absolute left-[52px] top-0 z-50 w-56 rounded-lg border bg-popover shadow-md p-1.5 text-sm">
                  <div className="px-2 py-1 text-xs font-semibold text-muted-foreground truncate">
                    {c.name}
                  </div>
                  {step === "menu" && (
                    <div className="flex flex-col">
                      {archived ? (
                        <MenuItem
                          icon={<ArchiveRestore className="w-4 h-4" />}
                          label="Unarchive"
                          onClick={() => void act(() => unarchiveCircle(c.circleId))}
                        />
                      ) : (
                        <MenuItem
                          icon={<Archive className="w-4 h-4" />}
                          label="Archive"
                          onClick={() => setStep("confirm-archive")}
                        />
                      )}
                      <MenuItem
                        icon={<Trash2 className="w-4 h-4" />}
                        label="Delete"
                        destructive
                        onClick={() => setStep("confirm-delete")}
                      />
                    </div>
                  )}
                  {step === "confirm-archive" && (
                    <Confirm
                      body="Hide this circle from your rail. It's kept and you can restore it anytime."
                      cta="Archive"
                      onCancel={() => setStep("menu")}
                      onConfirm={() => void act(() => archiveCircle(c.circleId))}
                      busy={busy}
                    />
                  )}
                  {step === "confirm-delete" && (
                    <Confirm
                      body="Permanently remove this circle and its history from this device. Your friends keep their own copy — this can't be undone."
                      cta="Delete"
                      destructive
                      onCancel={() => setStep("menu")}
                      onConfirm={() => void act(() => deleteCircle(c.circleId))}
                      busy={busy}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
      <div className="w-6 h-px bg-border" />
      <button
        type="button"
        onClick={onAdd}
        aria-label="Add a friend"
        title="Add a friend"
        className="w-10 h-10 rounded-[13px] grid place-items-center border border-dashed text-muted-foreground hover:text-foreground hover:border-circle-you"
      >
        <Plus className="w-5 h-5" />
      </button>
    </nav>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-left",
        destructive ? "text-destructive" : "text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Confirm({
  body,
  cta,
  onCancel,
  onConfirm,
  busy,
  destructive,
}: {
  body: string;
  cta: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  destructive?: boolean;
}) {
  return (
    <div className="px-2 py-1.5 space-y-2">
      <p className="text-xs text-muted-foreground">{body}</p>
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-muted-foreground px-2 py-1"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={cn(
            "text-xs font-medium px-3 py-1 rounded text-white disabled:opacity-50",
            destructive ? "bg-destructive" : "bg-circle-you",
          )}
        >
          {cta}
        </button>
      </div>
    </div>
  );
}
