import { Sparkles, X } from "lucide-react";
import { useState } from "react";
import {
  memberName,
  useCirclesStore,
  type AgentDraft,
  type Circle,
} from "../../stores/circles-store";

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
  const [text, setText] = useState(draft.content);
  const [busy, setBusy] = useState(false);

  const publish = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await publishDraft(circle.circleId, draft.draftId, text);
    setBusy(false);
  };

  const discard = async () => {
    if (busy) return;
    setBusy(true);
    await discardDraft(circle.circleId, draft.draftId);
    setBusy(false);
  };

  return (
    <div className="mx-3 mb-1 rounded-lg border border-primary/40 bg-primary/5 p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs">
        <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="font-medium text-primary">
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
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={2000}
        className="w-full resize-none rounded border bg-background/60 text-sm outline-none px-2 py-1.5"
      />
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={() => void discard()}
          disabled={busy}
          className="text-xs text-muted-foreground px-2 py-1"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={() => void publish()}
          disabled={!text.trim() || busy}
          className="text-xs font-medium px-3 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
        >
          Publish to circle
        </button>
      </div>
    </div>
  );
}
