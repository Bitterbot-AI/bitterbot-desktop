import { Archive, ArchiveRestore, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { useCirclesStore, type Circle } from "../../stores/circles-store";
import { approvalsTitle, AttentionBadge } from "./AttentionBadge";
import { circleIdentity } from "./circle-identity";

// PLAN-36 Phase A + Phase B (identity & lifecycle): the left circle rail.
// Every tile carries the circle's own identity — a circleId-derived gradient
// plus the name's leading emoji (or initials) — so three circles never look
// like one circle three times. Archived circles are actually HIDDEN (the
// confirm promises it); a footer toggle reveals them for restore. The tile
// list scrolls; the "+" is pinned and can't be pushed off-screen. The "⋯"
// menu positions fixed so it never clips against the scroller.

type Step = "menu" | "rename" | "confirm-archive" | "confirm-delete";

interface Props {
  circles: Circle[];
  activeCircleId: string | null;
  onSelect: (circleId: string) => void;
  onAdd: () => void;
}

export function CircleRail({ circles, activeCircleId, onSelect, onAdd }: Props) {
  const archiveCircle = useCirclesStore((s) => s.archiveCircle);
  const renameCircle = useCirclesStore((s) => s.renameCircle);
  const unarchiveCircle = useCirclesStore((s) => s.unarchiveCircle);
  const deleteCircle = useCirclesStore((s) => s.deleteCircle);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [step, setStep] = useState<Step>("menu");
  const [busy, setBusy] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const archivedCircles = circles.filter((c) => c.status === "archived");
  const visibleCircles = circles.filter((c) => c.status !== "archived");
  // If the ACTIVE circle is archived (picked via the toggle, or auto-archived
  // server-side like the practice circle), keep the archived tiles visible —
  // a selected chat must never point at a tile the rail is hiding.
  const activeIsArchived = archivedCircles.some((c) => c.circleId === activeCircleId);
  const revealArchived = showArchived || activeIsArchived;
  const shown = revealArchived ? [...visibleCircles, ...archivedCircles] : visibleCircles;

  const openMenu = (circleId: string, anchor: HTMLElement) => {
    // Fixed positioning ANCHORED TO THE TRIGGER's viewport rect: the menu
    // must escape the tile scroller's clip, must not assume the rail sits at
    // viewport x=0 (the app sidebar is to its left), and tiles near the
    // bottom must not push it below the fold (~260px covers the tallest
    // step). Scrolling the rail closes it — a one-shot position must never
    // drift onto a different tile.
    const rect = anchor.getBoundingClientRect();
    setMenuPos({
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 260)),
      left: rect.right + 8,
    });
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
      className="w-[60px] shrink-0 border-r bg-muted/40 flex flex-col items-center py-3"
      aria-label="Your circles"
    >
      <div
        onScroll={menuFor ? close : undefined}
        className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden flex flex-col items-center gap-2.5 py-1 [scrollbar-width:none]"
      >
        {shown.map((c) => {
          const active = c.circleId === activeCircleId;
          const unread = c.unread ?? 0;
          const archived = c.status === "archived";
          const id = circleIdentity(c.circleId, c.name);
          return (
            <div key={c.circleId} className="group relative shrink-0">
              <button
                type="button"
                onClick={() => onSelect(c.circleId)}
                title={archived ? `${c.name} (archived)` : c.name}
                aria-label={unread > 0 ? `${c.name}, ${unread} unread` : c.name}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "w-10 h-10 grid place-items-center font-bold text-white transition-all",
                  id.emoji ? "text-lg" : "text-sm",
                  active
                    ? "rounded-[15px] ring-2 ring-circle-you ring-offset-2 ring-offset-muted/40"
                    : "rounded-[13px]",
                  archived && "opacity-40 grayscale",
                )}
                style={{ background: id.gradient }}
              >
                {id.emoji ?? id.initials}
              </button>

              {!active && (
                <AttentionBadge
                  count={unread}
                  tone="unread"
                  className="absolute -top-1 -right-1 border-2 border-muted/40"
                />
              )}

              {/* §5.3 approvals awaiting the human: amber (consent), shown
                  even on the active tile — an expiring approval must never
                  be one quiet grey line (Phase C). */}
              <AttentionBadge
                count={c.pendingApprovals ?? 0}
                tone="consent"
                title={approvalsTitle(c.pendingApprovals ?? 0)}
                className="absolute -top-1 -left-1 border-2 border-muted/40"
              />

              {/* Hover-reveal menu trigger. */}
              <button
                type="button"
                onClick={(e) => openMenu(c.circleId, e.currentTarget)}
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
                  <div
                    className="fixed z-50 w-56 rounded-lg border bg-popover shadow-md p-1.5 text-sm"
                    style={{ top: menuPos.top, left: menuPos.left }}
                  >
                    <div className="px-2 py-1 text-xs font-semibold text-muted-foreground truncate">
                      {c.name}
                    </div>
                    {step === "menu" && (
                      <div className="flex flex-col">
                        <MenuItem
                          icon={<Pencil className="w-4 h-4" />}
                          label="Rename"
                          onClick={() => {
                            setNameDraft(c.name);
                            setStep("rename");
                          }}
                        />
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
                    {step === "rename" && (
                      <div className="p-2 space-y-1.5">
                        <input
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && nameDraft.trim())
                              void act(() => renameCircle(c.circleId, nameDraft));
                            if (e.key === "Escape") close();
                          }}
                          maxLength={80}
                          autoFocus
                          aria-label="Circle name"
                          className="w-full rounded border bg-background/60 text-xs outline-none px-2 py-1"
                        />
                        <p className="text-badge text-muted-foreground">
                          Current members keep their own name for it; new invites use this one.
                          Start with an emoji to put it on the tile.
                        </p>
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            type="button"
                            onClick={close}
                            className="text-xs text-muted-foreground px-2 py-0.5"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void act(() => renameCircle(c.circleId, nameDraft))}
                            disabled={busy || !nameDraft.trim()}
                            className="text-xs font-medium px-2 py-0.5 rounded bg-circle-you text-circle-you-fg disabled:opacity-50"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    )}
                    {step === "confirm-archive" && (
                      <Confirm
                        body="Hide this circle from your rail. It's kept and you can restore it anytime from the archive toggle below the rail."
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
      </div>

      {/* Pinned footer: the "+" (and the archive toggle) survive any circle count. */}
      <div className="shrink-0 flex flex-col items-center gap-2.5 pt-2.5">
        <div className="w-6 h-px bg-border" />
        {archivedCircles.length > 0 && (
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            aria-pressed={revealArchived}
            aria-label={
              revealArchived
                ? "Hide archived circles"
                : `Show ${archivedCircles.length} archived ${archivedCircles.length === 1 ? "circle" : "circles"}`
            }
            title={revealArchived ? "Hide archived" : "Show archived"}
            className={cn(
              "w-10 h-8 rounded-[10px] grid place-items-center border border-dashed",
              revealArchived
                ? "text-foreground border-circle-you"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Archive className="w-4 h-4" />
          </button>
        )}
        <button
          type="button"
          onClick={onAdd}
          aria-label="New circle"
          title="New circle — create one or add a friend"
          className="w-10 h-10 rounded-[13px] grid place-items-center border border-dashed text-muted-foreground hover:text-foreground hover:border-circle-you"
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>
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
