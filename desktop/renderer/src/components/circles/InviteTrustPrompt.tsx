import { truncatePubkey } from "../../lib/pubkey";

// The one consent surface for joining a circle, shared by every join path
// (Phase B join parity): the in-message "Join this circle" tap and the
// paste-a-code box run the SAME signature-verified preview through this
// prompt. The code's VERIFIED signer can differ from whoever delivered it —
// knownAs resolves petname-first from YOUR labels; a stranger's claimed name
// must never read as a trusted contact.

export interface InvitePreview {
  code: string;
  circleName: string;
  inviterName: string | null;
  inviterPubkey: string;
  /** Your label for the verified signer when you already know them. */
  knownAs?: string | null;
}

export function InviteTrustPrompt({
  preview,
  onCancel,
  onJoin,
  busy,
}: {
  preview: InvitePreview;
  onCancel: () => void;
  onJoin: () => void;
  busy?: boolean;
}) {
  return (
    <div className="rounded-lg border border-circle-you/40 bg-circle-you-soft/50 p-2.5 text-xs space-y-1.5">
      <p>
        Join <span className="font-semibold">{preview.circleName}</span>?{" "}
        {preview.knownAs ? (
          <>
            This invite is signed by your contact{" "}
            <span className="font-medium">{preview.knownAs}</span>{" "}
            <span className="font-mono text-muted-foreground">
              ({truncatePubkey(preview.inviterPubkey)})
            </span>
            .
          </>
        ) : (
          <>
            <span className="font-medium text-circle-consent">
              This invite is signed by someone you don&apos;t know
            </span>{" "}
            <span className="font-mono text-muted-foreground">
              ({truncatePubkey(preview.inviterPubkey)})
            </span>
            . The name &quot;{preview.inviterName ?? "unnamed"}&quot; is their own claim. Only join
            circles from people you trust.
          </>
        )}
      </p>
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground px-2 py-0.5"
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onJoin}
          disabled={busy}
          className="font-medium px-2.5 py-0.5 rounded bg-circle-you text-circle-you-fg disabled:opacity-50"
        >
          Join
        </button>
      </div>
    </div>
  );
}
