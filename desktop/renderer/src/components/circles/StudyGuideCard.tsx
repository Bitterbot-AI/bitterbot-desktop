import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { useCirclesStore, type Circle, type CanvasCard } from "../../stores/circles-store";

// PLAN-36 C3: the study-guide Co-Canvas — the §2.5 beachhead card. The creator
// posts the guide's SECTIONS (card.text, one per line); each member contributes
// their piece per section as a separate signed slice (slot = the section's
// stable id, LWW per (card, slot, author)), so the guide assembles from
// everyone's contributions and uncovered sections read as GAPS. In Phase B the
// member's agent drafts their slice from private context; the human still
// clicks to publish. Contributions are peer content: injection-scanned on
// receipt, rendered as escaped text (never HTML).

/**
 * A section's slice slot: "sec-" + FNV-1a of the normalized section title.
 * Deterministic on every node with no coordination; trim/case changes to a
 * section keep its contributions, a real rename orphans them (the same
 * documented caveat as editing a Decision Card's options). A crafted hash
 * collision only merges two sections' contribution lists — cosmetic.
 */
export function sectionSlot(section: string): string {
  const s = section.trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `sec-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** The card's sections: one per line, deduped by slot. */
export function parseSections(text: string): string[] {
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const line of text.split("\n")) {
    const section = line.trim();
    if (!section) continue;
    const slot = sectionSlot(section);
    if (seen.has(slot)) continue;
    seen.add(slot);
    sections.push(section);
  }
  return sections;
}

function nameFor(circle: Circle, pubkey: string, selfPubkey: string | undefined): string {
  if (pubkey === selfPubkey) return "You";
  return circle.members.find((m) => m.memberPubkey === pubkey)?.displayName ?? "friend";
}

export function StudyGuideCard({
  card,
  circle,
  selfPubkey,
}: {
  card: CanvasCard;
  circle: Circle;
  selfPubkey: string | undefined;
}) {
  const putSlice = useCirclesStore((s) => s.putSlice);
  const sections = parseSections(card.text);
  const [editingSlot, setEditingSlot] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [publishing, setPublishing] = useState(false);

  const slicesFor = (slot: string) => card.slices.filter((s) => s.slot === slot);
  const covered = sections.filter((sec) => slicesFor(sectionSlot(sec)).length > 0).length;
  const contributors = new Set(card.slices.map((s) => s.authorPubkey)).size;

  const openEditor = (slot: string) => {
    const mine = slicesFor(slot).find((s) => s.authorPubkey === selfPubkey);
    setDraft(mine?.value ?? "");
    setDraftNote(mine?.note ?? "");
    setEditingSlot(slot);
  };

  const publish = async (slot: string) => {
    if (!draft.trim() || publishing) return;
    setPublishing(true);
    const ok = await putSlice(circle.circleId, card.cardId, slot, draft.trim(), draftNote.trim());
    setPublishing(false);
    if (ok) setEditingSlot(null);
  };

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="p-3 pb-2">
        <div className="text-[10px] font-bold uppercase tracking-wide text-primary mb-1">
          Study guide · {covered} of {sections.length} sections covered
        </div>
        <div className="text-sm font-semibold">{card.title}</div>
        {contributors > 0 && (
          <div className="mt-1 text-xs text-muted-foreground">
            {card.slices.length} contribution{card.slices.length === 1 ? "" : "s"} from{" "}
            {contributors} member{contributors === 1 ? "" : "s"}
          </div>
        )}
      </div>

      <div className="px-3 pb-3 space-y-2">
        {sections.map((section) => {
          const slot = sectionSlot(section);
          const slices = slicesFor(slot);
          const mine = slices.find((s) => s.authorPubkey === selfPubkey);
          const isGap = slices.length === 0;
          const editing = editingSlot === slot;
          return (
            <div
              key={slot}
              className={cn(
                "rounded-md border px-2.5 py-2",
                isGap ? "border-dashed border-amber-500/50" : "border-border",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium flex-1 min-w-0 truncate">{section}</span>
                {isGap && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-500 shrink-0">
                    gap
                  </span>
                )}
                {circle.status === "active" && !editing && (
                  <button
                    type="button"
                    onClick={() => openEditor(slot)}
                    className="text-xs font-medium text-primary flex items-center gap-1 shrink-0"
                  >
                    {mine ? (
                      <>
                        <Pencil className="w-3 h-3" /> Edit yours
                      </>
                    ) : (
                      <>
                        <Plus className="w-3 h-3" /> Add yours
                      </>
                    )}
                  </button>
                )}
              </div>

              {slices.map((s) => (
                <div key={`${s.slot}\n${s.authorPubkey}`} className="mt-1.5">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    {nameFor(circle, s.authorPubkey, selfPubkey)}
                  </div>
                  <div className="text-sm whitespace-pre-wrap break-words">{s.value}</div>
                  {s.note && (
                    <div className="text-[11px] italic text-muted-foreground break-words">
                      {s.note}
                    </div>
                  )}
                </div>
              ))}

              {editing && (
                <div className="mt-2 space-y-1.5">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={`Your piece of “${section}” — key points, mnemonics, worked examples…`}
                    rows={3}
                    maxLength={2000}
                    autoFocus
                    className="w-full resize-none rounded border bg-transparent text-sm outline-none px-2 py-1.5"
                  />
                  <input
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    placeholder="Source? (optional — e.g. lecture 12)"
                    maxLength={1000}
                    className="w-full bg-transparent text-xs outline-none"
                  />
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => setEditingSlot(null)}
                      className="text-xs text-muted-foreground px-2 py-1"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void publish(slot)}
                      disabled={!draft.trim() || publishing}
                      className="text-xs font-medium px-3 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
                    >
                      {mine ? "Update my contribution" : "Publish my contribution"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
