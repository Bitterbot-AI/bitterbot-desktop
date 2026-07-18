import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useCirclesStore, type Circle } from "../../stores/circles-store";

// PLAN-36 Phase D: fork-freeze recovery. A same-seq divergence in a member's
// signed event chain froze this circle (writes refused on THIS node). The
// banner shows the human the recorded evidence and makes unfreezing a
// deliberate two-tap act. Common benign cause: a member restored their node
// from a backup and replayed older history; the malicious read is tampering.

type Evidence = {
  author_pubkey?: string;
  seq?: number;
  detected_at?: number;
};

function parseEvidence(freezeReason: string | null | undefined): Evidence | null {
  if (!freezeReason) return null;
  try {
    const parsed = JSON.parse(freezeReason) as Evidence;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function FrozenCircleBanner({ circle }: { circle: Circle }) {
  const unfreeze = useCirclesStore((s) => s.unfreeze);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const evidence = parseEvidence(circle.freezeReason);
  const who = evidence?.author_pubkey
    ? (circle.members.find((m) => m.memberPubkey === evidence.author_pubkey)?.displayName ??
      `${evidence.author_pubkey.slice(0, 24)}…`)
    : null;

  const doUnfreeze = async () => {
    if (busy) return;
    setBusy(true);
    await unfreeze(circle.circleId);
    setBusy(false);
  };

  return (
    <div className="mx-3 mb-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-500 shrink-0" />
        <span className="text-sm font-semibold">This circle is frozen</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {who ? (
          <>
            Two different versions of <span className="font-medium">{who}</span>&apos;s signed
            history{evidence?.seq !== undefined ? ` (entry #${evidence.seq})` : ""} reached this
            node, so writes were stopped to protect the shared record.
          </>
        ) : (
          <>
            A conflict in a member&apos;s signed history reached this node, so writes were stopped
            to protect the shared record.
          </>
        )}{" "}
        This usually means they restored their node from a backup; it can also indicate tampering.
        Unfreezing resumes the circle on <span className="font-medium">your node only</span> — their
        older shared items may stay out of sync until they reconnect cleanly, and this same conflict
        won&apos;t freeze the circle again. If new conflicts keep appearing, treat the circle as
        compromised and start a fresh one without them.
      </p>
      {confirming ? (
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-xs text-muted-foreground px-2 py-1"
          >
            Keep frozen
          </button>
          <button
            type="button"
            onClick={() => void doUnfreeze()}
            disabled={busy}
            className="text-xs font-medium px-3 py-1 rounded bg-amber-600 text-white disabled:opacity-50"
          >
            Yes, unfreeze
          </button>
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-xs font-medium px-3 py-1 rounded border border-amber-600/60 text-amber-700 dark:text-amber-500"
          >
            Review &amp; unfreeze…
          </button>
        </div>
      )}
    </div>
  );
}
