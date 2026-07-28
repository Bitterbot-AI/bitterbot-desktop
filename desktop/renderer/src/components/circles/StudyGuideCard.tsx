import { GraduationCap, Pencil, Plus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import {
  memberName,
  useCirclesStore,
  type Circle,
  type CanvasCard,
} from "../../stores/circles-store";
import { AgentSliceSuggestion } from "./AgentSliceSuggestion";
import { StudyLens } from "./StudyLens";

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
 * Deterministic on every node with no coordination; NFC/trim/case variants of
 * a section keep its contributions (two members' IMEs may emit different
 * Unicode normalization forms of the same title), a real rename orphans them
 * (the same documented caveat as editing a Decision Card's options). A crafted
 * hash collision only merges two sections' contribution lists — cosmetic.
 * Golden values are pinned in StudyGuideCard.test.ts; the server-side C3 test
 * uses them as literals, so changing this function is a breaking change.
 */
export function sectionSlot(section: string): string {
  const s = section.normalize("NFC").trim().toLowerCase();
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
  const found = circle.members.find((m) => m.memberPubkey === pubkey);
  return found ? memberName(found) : "friend";
}

export function StudyGuideCard({
  card,
  circle,
  selfPubkey,
  children,
}: {
  card: CanvasCard;
  circle: Circle;
  selfPubkey: string | undefined;
  /** The card's live layer (agents + people working it). */
  children?: React.ReactNode;
}) {
  const putSlice = useCirclesStore((s) => s.putSlice);
  const requestSliceDraft = useCirclesStore((s) => s.requestSliceDraft);
  const requestStudyDraft = useCirclesStore((s) => s.requestStudyDraft);
  const loadStudyState = useCirclesStore((s) => s.loadStudyState);
  const studyState = useCirclesStore((s) => s.studyByCard[`${circle.circleId}:${card.cardId}`]);
  const agentDrafts = useCirclesStore((s) => s.draftsByCircle[circle.circleId]);
  const sections = parseSections(card.text);
  const [editingSlot, setEditingSlot] = useState<string | null>(null);
  const [askedSlots, setAskedSlots] = useState<Record<string, boolean>>({});
  const [askedStudy, setAskedStudy] = useState(false);
  // Phase 4b: MY mastery per section, for due badges + the study lens.
  useEffect(() => {
    void loadStudyState(circle.circleId, card.cardId);
  }, [loadStudyState, circle.circleId, card.cardId]);
  const studyDraft = (agentDrafts ?? []).find(
    (d) => d.kind === "study" && d.targetCardId === card.cardId,
  );
  const dueBySlot = new Map(
    (studyState ?? []).map((s) => [s.slot, s.dueAt <= Date.now()] as const),
  );
  // Drafts are keyed by slot so switching sections mid-edit never discards
  // unsaved text (review finding #4).
  const [drafts, setDrafts] = useState<Record<string, { value: string; note: string }>>({});
  const [publishing, setPublishing] = useState(false);

  // One pass over the slices (a hostile card can carry thousands; review #3).
  const slicesBySlot = new Map<string, typeof card.slices>();
  for (const s of card.slices) {
    const list = slicesBySlot.get(s.slot);
    if (list) list.push(s);
    else slicesBySlot.set(s.slot, [s]);
  }
  const slicesFor = (slot: string) => slicesBySlot.get(slot) ?? [];
  const covered = sections.filter((sec) => slicesFor(sectionSlot(sec)).length > 0).length;
  const contributors = new Set(card.slices.map((s) => s.authorPubkey)).size;

  const openEditor = (slot: string) => {
    const mine = slicesFor(slot).find((s) => s.authorPubkey === selfPubkey);
    setDrafts((prev) =>
      prev[slot] ? prev : { ...prev, [slot]: { value: mine?.value ?? "", note: mine?.note ?? "" } },
    );
    setEditingSlot(slot);
  };

  const closeEditor = (slot: string) => {
    setDrafts(({ [slot]: _dropped, ...rest }) => rest);
    setEditingSlot((cur) => (cur === slot ? null : cur));
  };

  const publish = async (slot: string) => {
    const draft = drafts[slot];
    if (!draft?.value.trim() || publishing) return;
    setPublishing(true);
    const ok = await putSlice(
      circle.circleId,
      card.cardId,
      slot,
      draft.value.trim(),
      draft.note.trim(),
    );
    setPublishing(false);
    if (ok) closeEditor(slot);
  };

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="p-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1 flex-1">
            Study guide · {covered} of {sections.length} sections covered
          </div>
          {circle.status === "active" && !studyDraft && sections.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setAskedStudy(true);
                void requestStudyDraft(circle.circleId, card.cardId);
              }}
              disabled={askedStudy}
              title="Your agent builds a private quiz + gap map from this guide, tuned to what YOU have missed. It renders only to you."
              className="text-xs font-medium text-circle-agent flex items-center gap-1 shrink-0 disabled:opacity-50"
            >
              <GraduationCap className="w-3 h-3" />
              {askedStudy ? "Building…" : "Study with my agent"}
            </button>
          )}
        </div>
        <div className="text-sm font-semibold">{card.title}</div>
        {contributors > 0 && (
          <div className="mt-1 text-xs text-muted-foreground">
            {card.slices.length} contribution{card.slices.length === 1 ? "" : "s"} from{" "}
            {contributors} member{contributors === 1 ? "" : "s"}
          </div>
        )}
        {studyDraft && (
          <StudyLens
            key={studyDraft.draftId}
            draft={studyDraft}
            circleId={circle.circleId}
            cardId={card.cardId}
            validSlots={new Set(sections.map(sectionSlot))}
          />
        )}
      </div>

      <div className="px-3 pb-3 space-y-2">
        {sections.map((section) => {
          const slot = sectionSlot(section);
          const slices = slicesFor(slot);
          const mine = slices.find((s) => s.authorPubkey === selfPubkey);
          const isGap = slices.length === 0;
          const editing = editingSlot === slot;
          // B2: a ready agent suggestion targeting this section.
          const suggestion = (agentDrafts ?? []).find(
            (d) => d.targetCardId === card.cardId && d.targetSlot === slot,
          );
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
                {dueBySlot.get(slot) && (
                  <span
                    title="Your spaced-repetition schedule says review this section now"
                    className="text-[10px] font-semibold uppercase tracking-wide text-circle-agent shrink-0"
                  >
                    review due
                  </span>
                )}
                {circle.status === "active" && !editing && (
                  <>
                    {!suggestion && (
                      <button
                        type="button"
                        onClick={() => {
                          setAskedSlots((prev) => ({ ...prev, [slot]: true }));
                          void requestSliceDraft(circle.circleId, card.cardId, slot);
                        }}
                        disabled={askedSlots[slot]}
                        title="Your agent drafts this section privately; you review and publish"
                        className="text-xs font-medium text-circle-agent flex items-center gap-1 shrink-0 disabled:opacity-50"
                      >
                        <Sparkles className="w-3 h-3" />
                        {askedSlots[slot] ? "Drafting…" : "Ask my agent"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openEditor(slot)}
                      className="text-xs font-medium text-circle-you flex items-center gap-1 shrink-0"
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
                  </>
                )}
              </div>

              {suggestion && (
                <AgentSliceSuggestion
                  key={suggestion.draftId}
                  draft={suggestion}
                  circleId={circle.circleId}
                />
              )}

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
                    value={drafts[slot]?.value ?? ""}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [slot]: { value: e.target.value, note: prev[slot]?.note ?? "" },
                      }))
                    }
                    placeholder={`Your piece of “${section}” — key points, mnemonics, worked examples…`}
                    rows={3}
                    maxLength={2000}
                    autoFocus
                    className="w-full resize-none rounded border bg-transparent text-sm outline-none px-2 py-1.5"
                  />
                  <input
                    value={drafts[slot]?.note ?? ""}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [slot]: { value: prev[slot]?.value ?? "", note: e.target.value },
                      }))
                    }
                    placeholder="Source? (optional — e.g. lecture 12)"
                    maxLength={1000}
                    className="w-full bg-transparent text-xs outline-none"
                  />
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => closeEditor(slot)}
                      className="text-xs text-muted-foreground px-2 py-1"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void publish(slot)}
                      disabled={!drafts[slot]?.value.trim() || publishing}
                      className="text-xs font-medium px-3 py-1 rounded bg-circle-you text-circle-you-fg disabled:opacity-50"
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
      {children}
    </div>
  );
}
