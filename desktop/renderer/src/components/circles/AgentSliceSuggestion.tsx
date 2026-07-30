import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useCirclesStore, type AgentDraft } from "../../stores/circles-store";
import { RedactableDraftLines, useDraftConsent } from "./RedactableDraftLines";

// PLAN-36 B2: the consent surface for an agent-drafted card slice — the agent
// pre-filled YOUR vote / section contribution on the quarantined path; it is
// visible only to you, editable, and reaches the circle only via the publish
// tap (server-side it ships through the normal circles.canvas.slice path).

export function AgentSliceSuggestion({
  draft,
  circleId,
  editable = true,
  canPublish = true,
  hint,
}: {
  draft: AgentDraft;
  circleId: string;
  /** Vote suggestions are constrained to options — shown read-only. */
  editable?: boolean;
  /** e.g. false when a vote suggestion doesn't match any option (ABSTAIN). */
  canPublish?: boolean;
  hint?: string;
}) {
  const publishDraft = useCirclesStore((s) => s.publishDraft);
  const discardDraft = useCirclesStore((s) => s.discardDraft);
  const consent = useDraftConsent(draft.content);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    await fn();
    setBusy(false);
  };
  const lineReview = editable && !consent.editing;

  return (
    <div className="mt-2 rounded-md border border-circle-agent/40 border-l-2 border-l-circle-agent bg-circle-agent-soft/50 p-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-2xs">
        <Sparkles className="w-3 h-3 text-circle-agent shrink-0" />
        <span className="font-medium text-circle-agent">Your agent suggests</span>
        <span className="text-muted-foreground">· only you can see this</span>
      </div>
      {!editable ? (
        <div className="text-sm font-medium px-1">{consent.text}</div>
      ) : lineReview ? (
        // Mockup consent card: share only what you choose, line by line.
        <RedactableDraftLines
          lines={consent.lines}
          redacted={consent.redacted}
          onToggle={consent.toggle}
        />
      ) : (
        <textarea
          value={consent.text}
          onChange={(e) => consent.setText(e.target.value)}
          rows={3}
          maxLength={2000}
          className="w-full resize-none rounded border bg-background/60 text-sm outline-none px-2 py-1.5"
        />
      )}
      <div className="flex items-center gap-2 justify-end">
        {hint && <span className="mr-auto text-2xs text-muted-foreground">{hint}</span>}
        <button
          type="button"
          onClick={() => void act(() => discardDraft(circleId, draft.draftId))}
          disabled={busy}
          className="text-xs text-muted-foreground px-2 py-1"
        >
          Dismiss
        </button>
        {lineReview && (
          <button
            type="button"
            onClick={consent.startEditing}
            disabled={busy}
            className="text-xs font-medium px-2 py-1 rounded border text-muted-foreground hover:text-foreground"
          >
            Edit first
          </button>
        )}
        <button
          type="button"
          onClick={() => void act(() => publishDraft(circleId, draft.draftId, consent.finalText()))}
          disabled={!consent.finalText() || busy || !canPublish}
          className="text-xs font-medium px-3 py-1 rounded bg-circle-agent text-circle-agent-fg disabled:opacity-50"
        >
          Publish
        </button>
      </div>
    </div>
  );
}
