import { Sparkles, X } from "lucide-react";
import { useState } from "react";
import {
  memberName,
  useCirclesStore,
  type AgentDraft,
  type Circle,
} from "../../stores/circles-store";
import { RedactableDraftLines, useDraftConsent } from "./RedactableDraftLines";

// PLAN-36 Phase B: the consent surface for an @agent draft. The member's own
// agent wrote this on the quarantined tool-less path after someone summoned it;
// it is visible ONLY to this node's human and reaches the circle exclusively
// through the Publish tap below (editable first — what the human approves is
// what ships). Discard means nothing ever left the node.

function summonerName(circle: Circle, draft: AgentDraft, selfPubkey: string | undefined): string {
  if (!draft.summonAuthorPubkey) return "someone";
  if (draft.summonAuthorPubkey === selfPubkey) return "you";
  const found = circle.members.find((m) => m.memberPubkey === draft.summonAuthorPubkey);
  return found ? memberName(found) : "a friend";
}

export function AgentDraftCard({
  draft,
  circle,
  selfPubkey,
}: {
  draft: AgentDraft;
  circle: Circle;
  selfPubkey: string | undefined;
}) {
  const publishDraft = useCirclesStore((s) => s.publishDraft);
  const discardDraft = useCirclesStore((s) => s.discardDraft);
  const consent = useDraftConsent(draft.content);
  const [busy, setBusy] = useState(false);

  const publish = async () => {
    const out = consent.finalText();
    if (!out || busy) return;
    setBusy(true);
    await publishDraft(circle.circleId, draft.draftId, out);
    setBusy(false);
  };

  const discard = async () => {
    if (busy) return;
    setBusy(true);
    await discardDraft(circle.circleId, draft.draftId);
    setBusy(false);
  };

  return (
    <div className="mx-3 mb-1 rounded-lg border border-circle-agent/40 border-l-2 border-l-circle-agent bg-circle-agent-soft/50 p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs">
        <Sparkles className="w-3.5 h-3.5 text-circle-agent shrink-0" />
        <span className="font-medium text-circle-agent">
          Your agent drafted a reply ({summonerName(circle, draft, selfPubkey)} summoned it)
        </span>
        <span className="text-muted-foreground">· only you can see this</span>
        <button
          type="button"
          onClick={() => void discard()}
          aria-label="Discard draft"
          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* Mockup consent card: share only what you choose. Multi-line drafts
          review line-by-line with per-line redact; "Edit first" is the
          free-text escape hatch. Redacted lines never leave the node. */}
      {consent.editing ? (
        <textarea
          value={consent.text}
          onChange={(e) => consent.setText(e.target.value)}
          rows={3}
          maxLength={2000}
          className="w-full resize-none rounded border bg-background/60 text-sm outline-none px-2 py-1.5"
        />
      ) : (
        <RedactableDraftLines
          lines={consent.lines}
          redacted={consent.redacted}
          onToggle={consent.toggle}
        />
      )}
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={() => void discard()}
          disabled={busy}
          className="text-xs text-muted-foreground px-2 py-1"
        >
          Discard
        </button>
        {!consent.editing && (
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
          onClick={() => void publish()}
          disabled={!consent.finalText() || busy}
          className="text-xs font-medium px-3 py-1 rounded bg-circle-agent text-circle-agent-fg disabled:opacity-50"
        >
          Publish to circle
        </button>
      </div>
    </div>
  );
}
