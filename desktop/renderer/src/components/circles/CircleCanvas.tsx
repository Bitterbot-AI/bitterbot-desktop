import { BookOpen, ListChecks, Plus, StickyNote, X } from "lucide-react";
import { useState } from "react";
import { useCirclesStore, type Circle } from "../../stores/circles-store";
import { DecisionCard } from "./DecisionCard";
import { StudyGuideCard } from "./StudyGuideCard";

// PLAN-36 Phase C: the group canvas — a board of typed cards folded from the
// circle event log (canvas.* events). C1 shipped the shared note; C2 adds the
// Decision Card (a constraint-aware poll whose votes are per-member slices);
// C3 the study-guide Co-Canvas (sections that assemble from per-member
// contribution slices — the §2.5 beachhead). Card content is peer content:
// injection-scanned on receipt, rendered as escaped text (never HTML).

type Mode = "note" | "decision" | "study" | null;

function nameFor(circle: Circle, pubkey: string, selfPubkey: string | undefined): string {
  if (pubkey === selfPubkey) return "You";
  return circle.members.find((m) => m.memberPubkey === pubkey)?.displayName ?? "friend";
}

function fmtWhen(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CircleCanvas({
  circle,
  selfPubkey,
}: {
  circle: Circle;
  selfPubkey: string | undefined;
}) {
  const cards = useCirclesStore((s) => s.cardsByCircle[circle.circleId]);
  const putCard = useCirclesStore((s) => s.putCard);
  const putDecision = useCirclesStore((s) => s.putDecision);
  const putStudyGuide = useCirclesStore((s) => s.putStudyGuide);
  const [mode, setMode] = useState<Mode>(null);
  const [saving, setSaving] = useState(false);
  // Note composer
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  // Decision composer
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  // Study-guide composer
  const [guideTitle, setGuideTitle] = useState("");
  const [guideSections, setGuideSections] = useState("");

  const reset = () => {
    setMode(null);
    setTitle("");
    setText("");
    setQuestion("");
    setOptions(["", ""]);
    setGuideTitle("");
    setGuideSections("");
  };

  const submitNote = async () => {
    if ((!title.trim() && !text.trim()) || saving) return;
    setSaving(true);
    const ok = await putCard(circle.circleId, title, text);
    setSaving(false);
    if (ok) reset();
  };

  const submitDecision = async () => {
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || opts.length < 2 || saving) return;
    setSaving(true);
    const ok = await putDecision(circle.circleId, question, opts);
    setSaving(false);
    if (ok) reset();
  };

  const submitStudyGuide = async () => {
    const secs = guideSections
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!guideTitle.trim() || secs.length === 0 || saving) return;
    setSaving(true);
    const ok = await putStudyGuide(circle.circleId, guideTitle, secs);
    setSaving(false);
    if (ok) reset();
  };

  const list = cards ?? [];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Shared canvas
        </span>
        {mode === null && circle.status === "active" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode("note")}
              className="text-xs font-medium text-primary flex items-center gap-1"
            >
              <StickyNote className="w-3.5 h-3.5" /> Note
            </button>
            <button
              type="button"
              onClick={() => setMode("decision")}
              className="text-xs font-medium text-primary flex items-center gap-1"
            >
              <ListChecks className="w-3.5 h-3.5" /> Decision
            </button>
            <button
              type="button"
              onClick={() => setMode("study")}
              className="text-xs font-medium text-primary flex items-center gap-1"
            >
              <BookOpen className="w-3.5 h-3.5" /> Guide
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {mode === "note" && (
          <div className="rounded-lg border bg-card p-2.5 space-y-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Card title"
              autoFocus
              className="w-full bg-transparent text-sm font-semibold outline-none"
            />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Anything the whole circle should see…"
              rows={3}
              className="w-full resize-none bg-transparent text-sm outline-none"
            />
            <ComposerActions onCancel={reset} onSave={() => void submitNote()} saving={saving} />
          </div>
        )}

        {mode === "decision" && (
          <div className="rounded-lg border bg-card p-2.5 space-y-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What are we deciding? (e.g. when do we review?)"
              autoFocus
              className="w-full bg-transparent text-sm font-semibold outline-none"
            />
            {options.map((opt, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={opt}
                  onChange={(e) =>
                    setOptions((prev) => prev.map((o, j) => (j === i ? e.target.value : o)))
                  }
                  placeholder={`Option ${i + 1}`}
                  className="flex-1 bg-transparent text-sm outline-none border-b border-border/60 py-0.5"
                />
                {options.length > 2 && (
                  <button
                    type="button"
                    aria-label="Remove option"
                    onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setOptions((prev) => [...prev, ""])}
              className="text-xs text-muted-foreground flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add option
            </button>
            <ComposerActions
              onCancel={reset}
              onSave={() => void submitDecision()}
              saving={saving}
              saveLabel="Post decision"
            />
          </div>
        )}

        {mode === "study" && (
          <div className="rounded-lg border bg-card p-2.5 space-y-2">
            <input
              value={guideTitle}
              onChange={(e) => setGuideTitle(e.target.value)}
              placeholder="Study guide title (e.g. BIO-204 Midterm 2)"
              autoFocus
              className="w-full bg-transparent text-sm font-semibold outline-none"
            />
            <textarea
              value={guideSections}
              onChange={(e) => setGuideSections(e.target.value)}
              placeholder={
                "Sections, one per line — everyone fills their piece\nGlycolysis\nKrebs cycle\nElectron transport"
              }
              rows={4}
              className="w-full resize-none bg-transparent text-sm outline-none"
            />
            <ComposerActions
              onCancel={reset}
              onSave={() => void submitStudyGuide()}
              saving={saving}
              saveLabel="Start guide"
            />
          </div>
        )}

        {list.length === 0 && mode === null && (
          <div className="text-center text-sm text-muted-foreground px-4 py-10">
            Nothing on the canvas yet. Add a shared note, post a decision to vote on, or start a
            study guide the whole circle fills in — soon your agents&apos; outputs will land here
            too.
          </div>
        )}

        {list.map((card) =>
          card.cardType === "decision" ? (
            <DecisionCard key={card.cardId} card={card} circle={circle} selfPubkey={selfPubkey} />
          ) : card.cardType === "study" ? (
            <StudyGuideCard key={card.cardId} card={card} circle={circle} selfPubkey={selfPubkey} />
          ) : (
            <div key={card.cardId} className="rounded-lg border bg-card p-3">
              {card.title && <div className="text-sm font-semibold mb-1">{card.title}</div>}
              {card.text && (
                <div className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                  {card.text}
                </div>
              )}
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium">
                  {nameFor(circle, card.authorPubkey, selfPubkey)}
                </span>
                <span>·</span>
                <span>{fmtWhen(card.updatedAt)}</span>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function ComposerActions({
  onCancel,
  onSave,
  saving,
  saveLabel = "Add to canvas",
}: {
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  saveLabel?: string;
}) {
  return (
    <div className="flex items-center gap-2 justify-end">
      <button type="button" onClick={onCancel} className="text-xs text-muted-foreground px-2 py-1">
        Cancel
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="text-xs font-medium px-3 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
      >
        {saveLabel}
      </button>
    </div>
  );
}
