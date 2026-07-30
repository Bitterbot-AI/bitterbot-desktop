import { Check, GraduationCap, X } from "lucide-react";
import { useState } from "react";
import { useCirclesStore, type AgentDraft } from "../../stores/circles-store";

// PLAN-36 Phase 4b: the study lens — the private render surface for a `study`
// agent draft (quiz + gap map built from the group's shared card, tuned to
// THIS member's mastery). Render-to-own-human only: the server refuses to
// publish study drafts, so this panel has no publish affordance at all — only
// quiz taps (which feed the member's own mastery state) and dismiss.

/**
 * Parse the draft's pinned output format: `Qn [<slot>] <question>` lines under
 * QUIZ, then everything from GAP MAP onward as prose. The model's slot tags
 * are validated against the card's REAL section slots by the caller — a
 * question tagged with an unknown slot renders read-only (no mastery taps),
 * so a confused or hostile generation can never write junk study state.
 */
export function parseStudyDraft(content: string): {
  quiz: Array<{ n: number; slot: string; question: string }>;
  rest: string;
} {
  const quiz: Array<{ n: number; slot: string; question: string }> = [];
  const lines = content.split("\n");
  const restStart = lines.findIndex((l) => /^GAP MAP\b/i.test(l.trim()));
  const head = restStart === -1 ? lines : lines.slice(0, restStart);
  for (const line of head) {
    const m = /^Q(\d+)\s*\[([a-z0-9_-]+)\]\s*(.+)$/i.exec(line.trim());
    if (m) quiz.push({ n: Number(m[1]), slot: m[2]!, question: m[3]! });
  }
  const rest = restStart === -1 ? "" : lines.slice(restStart).join("\n").trim();
  return { quiz, rest };
}

export function StudyLens({
  draft,
  circleId,
  cardId,
  validSlots,
}: {
  draft: AgentDraft;
  circleId: string;
  cardId: string;
  validSlots: Set<string>;
}) {
  const recordStudy = useCirclesStore((s) => s.recordStudy);
  const discardDraft = useCirclesStore((s) => s.discardDraft);
  const [answers, setAnswers] = useState<Record<number, "correct" | "missed">>({});
  const { quiz, rest } = parseStudyDraft(draft.content);

  const answer = (n: number, slot: string, correct: boolean) => {
    if (answers[n]) return;
    setAnswers((prev) => ({ ...prev, [n]: correct ? "correct" : "missed" }));
    void recordStudy(circleId, cardId, slot, correct);
  };

  return (
    <div className="mt-2 rounded-md border border-border border-l-2 border-l-circle-agent bg-card px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <GraduationCap className="w-3.5 h-3.5 text-circle-agent" />
        <span className="text-badge font-bold uppercase tracking-wide text-circle-agent flex-1">
          Your study lens — private, never posted
        </span>
        <button
          type="button"
          onClick={() => void discardDraft(circleId, draft.draftId)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
      </div>

      {quiz.length > 0 ? (
        <div className="space-y-1.5">
          {quiz.map((q) => {
            const answered = answers[q.n];
            const known = validSlots.has(q.slot);
            return (
              <div key={q.n} className="text-sm">
                <span className="whitespace-pre-wrap break-words">{q.question}</span>
                {known && !answered && (
                  <span className="ml-2 inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => answer(q.n, q.slot, true)}
                      aria-label={`Got question ${q.n} right`}
                      className="text-2xs font-medium rounded px-1.5 py-0.5 bg-circle-you-soft text-circle-you inline-flex items-center gap-0.5"
                    >
                      <Check className="w-3 h-3" /> Got it
                    </button>
                    <button
                      type="button"
                      onClick={() => answer(q.n, q.slot, false)}
                      aria-label={`Missed question ${q.n}`}
                      className="text-2xs font-medium rounded px-1.5 py-0.5 bg-muted text-muted-foreground inline-flex items-center gap-0.5"
                    >
                      <X className="w-3 h-3" /> Missed
                    </button>
                  </span>
                )}
                {answered && (
                  <span
                    className={
                      answered === "correct"
                        ? "ml-2 text-2xs font-medium text-circle-you"
                        : "ml-2 text-2xs font-medium text-amber-600 dark:text-amber-500"
                    }
                  >
                    {answered === "correct" ? "✓ recorded" : "✗ scheduled for review"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        // The model ignored the Q-line format: still show the human what
        // their agent wrote (it is their private draft), just without taps.
        <div className="text-sm whitespace-pre-wrap break-words">{draft.content}</div>
      )}

      {rest && (
        <div className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap break-words">
          {rest}
        </div>
      )}
    </div>
  );
}
