import {
  BookOpen,
  Bot,
  GitBranch,
  ListChecks,
  MoreHorizontal,
  Plus,
  StickyNote,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { memberName, useCirclesStore, type Circle } from "../../stores/circles-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { CardLiveLayer } from "./CardLiveLayer";
import { MermaidDiagram } from "./MermaidDiagram";
import { StudyGuideCard } from "./StudyGuideCard";

// PLAN-36 Phase C: the group canvas — a board of typed cards folded from the
// circle event log (canvas.* events). C1 shipped the shared note; C2 adds the
// Decision Card (a constraint-aware poll whose votes are per-member slices);
// C3 the study-guide Co-Canvas (sections that assemble from per-member
// contribution slices — the §2.5 beachhead). Card content is peer content:
// injection-scanned on receipt, rendered as escaped text (never HTML).

type Mode = "note" | "decision" | "study" | "diagram" | null;

function nameFor(circle: Circle, pubkey: string, selfPubkey: string | undefined): string {
  if (pubkey === selfPubkey) return "You";
  const found = circle.members.find((m) => m.memberPubkey === pubkey);
  return found ? memberName(found) : "friend";
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
  const removed = useCirclesStore((s) => s.removedByCircle[circle.circleId]);
  const sandbox = useCirclesStore((s) => s.sandboxByCircle[circle.circleId]);
  const removeCard = useCirclesStore((s) => s.removeCard);
  const clearCard = useCirclesStore((s) => s.clearCard);
  const undoRemoveCard = useCirclesStore((s) => s.undoRemoveCard);
  const putCard = useCirclesStore((s) => s.putCard);
  const putDecision = useCirclesStore((s) => s.putDecision);
  const putStudyGuide = useCirclesStore((s) => s.putStudyGuide);
  const setCanvasParticipation = useCirclesStore((s) => s.setCanvasParticipation);
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
  // Diagram composer (mermaid source; preview renders live below the editor,
  // debounced — most intermediate keystroke states are parse failures)
  const [diagramTitle, setDiagramTitle] = useState("");
  const [diagramCode, setDiagramCode] = useState("");
  const [previewCode, setPreviewCode] = useState("");

  const reset = () => {
    setMode(null);
    setTitle("");
    setText("");
    setQuestion("");
    setOptions(["", ""]);
    setGuideTitle("");
    setGuideSections("");
    setDiagramTitle("");
    setDiagramCode("");
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

  useEffect(() => {
    const timer = setTimeout(() => setPreviewCode(diagramCode), 400);
    return () => clearTimeout(timer);
  }, [diagramCode]);

  const submitDiagram = async () => {
    if (!diagramCode.trim() || saving) return;
    setSaving(true);
    const ok = await putCard(circle.circleId, diagramTitle, diagramCode, undefined, "mermaid");
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
              className="text-xs font-medium text-circle-you flex items-center gap-1"
            >
              <StickyNote className="w-3.5 h-3.5" /> Note
            </button>
            <button
              type="button"
              onClick={() => setMode("decision")}
              className="text-xs font-medium text-circle-you flex items-center gap-1"
            >
              <ListChecks className="w-3.5 h-3.5" /> Decision
            </button>
            <button
              type="button"
              onClick={() => setMode("study")}
              className="text-xs font-medium text-circle-you flex items-center gap-1"
            >
              <BookOpen className="w-3.5 h-3.5" /> Guide
            </button>
            <button
              type="button"
              onClick={() => setMode("diagram")}
              className="text-xs font-medium text-circle-you flex items-center gap-1"
            >
              <GitBranch className="w-3.5 h-3.5" /> Diagram
            </button>
          </div>
        )}
      </div>

      {/* The ONE consent control for the whole canvas: does my agent work
          here. Not a per-card act, not a mode — a standing choice, stated in
          plain words. */}
      {circle.status === "active" && (
        <label className="flex items-center gap-2 px-3 py-1.5 border-b text-[11px] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={sandbox?.participation?.mode === "propose"}
            onChange={(e) =>
              void setCanvasParticipation(circle.circleId, e.target.checked ? "propose" : "off")
            }
            className="accent-emerald-600"
          />
          <Bot className="w-3 h-3 text-circle-agent" />
          <span>
            My agent works on this canvas
            {sandbox?.participation?.mode === "propose" && (
              <span className="text-muted-foreground">
                {" "}
                — it suggests, you decide
                {sandbox.participation.turnBudget > 0 && (
                  <span className="tabular-nums">
                    {" "}
                    ({sandbox.participation.turnsUsed}/{sandbox.participation.turnBudget} turns)
                  </span>
                )}
              </span>
            )}
          </span>
        </label>
      )}

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

        {mode === "diagram" && (
          <div className="rounded-lg border bg-card p-2.5 space-y-2">
            <input
              value={diagramTitle}
              onChange={(e) => setDiagramTitle(e.target.value)}
              placeholder="Diagram title (optional)"
              autoFocus
              className="w-full bg-transparent text-sm font-semibold outline-none"
            />
            <textarea
              value={diagramCode}
              onChange={(e) => setDiagramCode(e.target.value)}
              placeholder={
                "Mermaid source, e.g.\ngraph TD\n  Trip --> Cabin\n  Trip --> Car\n  Cabin --> Split[Split on the tab]"
              }
              rows={6}
              spellCheck={false}
              className="w-full resize-none bg-transparent text-sm font-mono outline-none"
            />
            {previewCode.trim() && (
              <div className="rounded border border-border/40 bg-background/40 p-2">
                <MermaidDiagram code={previewCode} />
              </div>
            )}
            <ComposerActions
              onCancel={reset}
              onSave={() => void submitDiagram()}
              saving={saving}
              saveLabel="Post diagram"
            />
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
            Nothing on the canvas yet. Add a note, a decision to settle, or a study guide — every
            card is a live workspace your agents work alongside you.
          </div>
        )}

        {/* §3.2.9: removals are legible and reversible. A later put outwins
            the tombstone, so Undo is just re-putting the removed body. */}
        {(removed ?? []).slice(0, 3).map((r) => (
          <div
            key={`removed-${r.cardId}`}
            className="flex items-center justify-between rounded-lg border border-dashed px-3 py-1.5 text-[11px] text-muted-foreground"
          >
            <span className="truncate">
              {nameFor(circle, r.removedBy, selfPubkey)} removed “{r.title || "a card"}” ·{" "}
              {fmtWhen(r.removedAt)}
            </span>
            <button
              type="button"
              className="ml-2 shrink-0 font-medium underline-offset-2 hover:underline"
              onClick={() => void undoRemoveCard(circle.circleId, r)}
            >
              Undo
            </button>
          </div>
        ))}

        {list.map((card) => {
          // Every card carries the live layer — agents and people work the
          // card itself. There is no separate card type and nothing to enable.
          const live = (
            <CardLiveLayer
              cardId={card.cardId}
              circle={circle}
              selfPubkey={selfPubkey}
              sandbox={sandbox}
            />
          );
          // §3.2.9: every card can die — clear starts the work fresh under
          // the same title; delete tombstones it (undo-able above).
          const actions = (
            <div className="absolute right-2 top-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Card actions"
                    className="rounded p-1 text-muted-foreground hover:bg-muted"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => void clearCard(circle.circleId, card.cardId, true)}
                  >
                    Start fresh (keep content)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void clearCard(circle.circleId, card.cardId, false)}
                  >
                    Start fresh (empty)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => void removeCard(circle.circleId, card.cardId)}
                  >
                    Delete card
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
          if (card.cardType === "decision") {
            // ONE vote surface `[unified 2026-07-28]`: the live layer owns the
            // options and the tally (the fold seeds options from the card's
            // own lines and honors legacy slice votes), so the old
            // DecisionCard poll is gone — two disagreeing vote systems on one
            // card was the worst incoherence on the canvas.
            return (
              <div key={card.cardId} className="relative rounded-lg border bg-card p-3">
                {actions}
                <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
                  Decision
                </div>
                <div className="text-sm font-semibold pr-6">{card.title}</div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="font-medium">
                    {nameFor(circle, card.authorPubkey, selfPubkey)}
                  </span>
                  <span>·</span>
                  <span>{fmtWhen(card.updatedAt)}</span>
                </div>
                {live}
              </div>
            );
          }
          if (card.cardType === "study") {
            return (
              <div key={card.cardId} className="relative">
                {actions}
                <StudyGuideCard card={card} circle={circle} selfPubkey={selfPubkey}>
                  <div className="px-3 pb-3">{live}</div>
                </StudyGuideCard>
              </div>
            );
          }
          return (
            <div key={card.cardId} className="relative rounded-lg border bg-card p-3">
              {actions}
              {card.title && <div className="text-sm font-semibold mb-1 pr-6">{card.title}</div>}
              {card.cardType === "mermaid" ? (
                <MermaidDiagram code={card.text} />
              ) : (
                card.text && (
                  <div className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                    {card.text}
                  </div>
                )
              )}
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium">
                  {nameFor(circle, card.authorPubkey, selfPubkey)}
                </span>
                <span>·</span>
                <span>{fmtWhen(card.updatedAt)}</span>
              </div>
              {live}
            </div>
          );
        })}
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
        className="text-xs font-medium px-3 py-1 rounded bg-circle-you text-circle-you-fg disabled:opacity-50"
      >
        {saveLabel}
      </button>
    </div>
  );
}
