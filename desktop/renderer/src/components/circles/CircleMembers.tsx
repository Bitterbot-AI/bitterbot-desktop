import { AlertTriangle, Check, Pencil, UserMinus, X } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import {
  memberName,
  useCirclesStore,
  type Circle,
  type CircleMember,
} from "../../stores/circles-store";

// PLAN-36 Phase A: the member/presence roster. §5.5: ANY member can remove
// another from their OWN node. §5.6 petname layer: each friend can be given a
// PRIVATE label (only you see it) that overrides their self-asserted name — the
// anti-impersonation anchor. A skippable prompt nudges you to name new
// connections; the "unverified" hint and same-name collision badge surface who
// you haven't vouched for yet.

const ONLINE_WINDOW_MS = 10 * 60_000;
const DISMISS_KEY = "circles.petnamePromptDismissed";

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

function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function CircleMembers({ circle }: { circle: Circle }) {
  const removeMember = useCirclesStore((s) => s.removeMember);
  const setPetname = useCirclesStore((s) => s.setPetname);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);

  const canModerate = circle.status === "active";
  // §5.6: peers you haven't named yet (and haven't dismissed the nudge for).
  const unnamed = circle.members.filter(
    (m) => !m.isSelf && !m.petname && !dismissed.has(m.memberPubkey),
  );

  const openEditor = (m: CircleMember) => {
    setDraft(m.petname ?? "");
    setEditing(m.memberPubkey);
    setConfirmingRemove(null);
  };

  const savePetname = async (m: CircleMember) => {
    if (busy) return;
    setBusy(true);
    const ok = await setPetname(m.memberPubkey, draft);
    setBusy(false);
    if (ok) setEditing(null);
  };

  const dismiss = (pubkeys: string[]) => {
    const next = new Set(dismissed);
    for (const p of pubkeys) next.add(p);
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore persistence failure */
    }
  };

  const remove = async (memberPubkey: string) => {
    if (busy) return;
    setBusy(true);
    await removeMember(circle.circleId, memberPubkey);
    setBusy(false);
    setConfirmingRemove(null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
      {unnamed.length > 0 && editing === null && (
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-xs space-y-2">
          <p className="text-muted-foreground">
            Give {unnamed.length === 1 ? "this friend" : "these friends"} a name only you see — it
            keeps impostors from borrowing a name you trust.
          </p>
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={() => dismiss(unnamed.map((m) => m.memberPubkey))}
              className="text-muted-foreground px-2 py-1"
            >
              Not now
            </button>
            <button
              type="button"
              onClick={() => openEditor(unnamed[0] as CircleMember)}
              className="font-medium px-3 py-1 rounded bg-primary text-primary-foreground"
            >
              Name {unnamed.length === 1 ? memberName(unnamed[0] as CircleMember) : "them"}
            </button>
          </div>
        </div>
      )}

      {circle.members.map((m) => {
        const name = m.isSelf ? "You" : memberName(m);
        const st = statusOf(m.lastSeenAt, m.lastStatus);
        const removable = canModerate && !m.isSelf;
        const isEditing = editing === m.memberPubkey;
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
              <div className="min-w-0 flex flex-col">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold truncate">{name}</span>
                  {m.role === "creator" && (
                    <span className="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-muted text-muted-foreground shrink-0">
                      creator
                    </span>
                  )}
                  {m.nameCollision && (
                    <span
                      title="Another member you know also goes by this name — check who this is before trusting them."
                      className="text-amber-600 dark:text-amber-500 shrink-0"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" aria-label="shared name" />
                    </span>
                  )}
                </div>
                {/* If you renamed them, show their own name underneath. */}
                {!m.isSelf && m.petname && m.displayName && (
                  <span className="text-[11px] text-muted-foreground truncate">
                    they call themselves {m.displayName}
                  </span>
                )}
                {!m.isSelf && !m.petname && (
                  <span className="text-[11px] text-muted-foreground">
                    unverified — the name they chose
                  </span>
                )}
              </div>
              {!m.isSelf && !isEditing && (
                <button
                  type="button"
                  onClick={() => openEditor(m)}
                  aria-label={`Name ${name}`}
                  className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-foreground p-0.5 rounded shrink-0"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
              {removable && !isEditing && (
                <button
                  type="button"
                  onClick={() => setConfirmingRemove(m.memberPubkey)}
                  aria-label={`Remove ${name}`}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-destructive p-0.5 rounded shrink-0"
                >
                  <UserMinus className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {isEditing && (
              <div className="ml-8 flex items-center gap-1.5">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void savePetname(m);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  placeholder={m.displayName ?? "Their name (only you see it)"}
                  maxLength={80}
                  autoFocus
                  className="flex-1 min-w-0 rounded border bg-background/60 text-xs outline-none px-2 py-1"
                />
                <button
                  type="button"
                  onClick={() => void savePetname(m)}
                  disabled={busy}
                  aria-label="Save name"
                  className="text-primary p-1 disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  aria-label="Cancel"
                  className="text-muted-foreground p-1"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {removable && confirmingRemove === m.memberPubkey && (
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
                    onClick={() => setConfirmingRemove(null)}
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
