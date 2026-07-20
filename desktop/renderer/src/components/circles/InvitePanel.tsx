import { X } from "lucide-react";
import { useCallback, useState } from "react";
import { useCirclesStore } from "../../stores/circles-store";
import { useGatewayStore } from "../../stores/gateway-store";

// PLAN-36 Phase A: invite + join, moved out of the old PeopleView dashboard into
// a focused modal opened from the circle rail's "+". Same frictionless invite
// (link + QR + raw-code fallback) and paste-to-join flow.
//
// Two modes: default (no circleId) mints an invite that starts a NEW connection
// circle and offers the paste-to-join box; SCOPED (circleId set) mints an invite
// that grows an EXISTING circle — the invitee joins that circle, so the join box
// is hidden (you're adding to your own circle, not connecting to a new one).

export function InvitePanel({
  onClose,
  circleId,
  circleName,
}: {
  onClose: () => void;
  circleId?: string;
  circleName?: string;
}) {
  const request = useGatewayStore((s) => s.request);
  const refresh = useCirclesStore((s) => s.refresh);
  const setNotice = useCirclesStore((s) => s.setNotice);
  const scoped = !!circleId;

  const [invite, setInvite] = useState<{ code: string; link: string; qrPngBase64: string } | null>(
    null,
  );
  const [joinCode, setJoinCode] = useState("");
  const [local, setLocal] = useState<string | null>(null);

  const mintInvite = useCallback(async () => {
    try {
      const res = await request<{ code: string; link: string; qrPngBase64: string }>(
        "circles.invite",
        circleId ? { circleId } : {},
      );
      setInvite({ code: res.code, link: res.link, qrPngBase64: res.qrPngBase64 });
      void refresh();
    } catch (err) {
      setLocal(String(err));
    }
  }, [request, refresh, circleId]);

  const join = useCallback(async () => {
    if (!joinCode.trim()) return;
    try {
      const res = await request<{
        circleName: string;
        inviterName: string | null;
        status?: "connected" | "pending";
      }>("circles.join", { code: joinCode.trim() });
      const by = res.inviterName ? ` (invited by ${res.inviterName})` : "";
      setNotice(
        res.status === "pending"
          ? `Request sent to ${res.circleName}${by}. You'll connect as soon as they're online.`
          : `Connected: ${res.circleName}${by}`,
      );
      setJoinCode("");
      void refresh();
      onClose();
    } catch (err) {
      setLocal(String(err));
    }
  }, [request, joinCode, refresh, setNotice, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-2xl border bg-background shadow-xl p-5 space-y-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Invite or join a circle"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg">
            {scoped ? `Invite to ${circleName ?? "this circle"}` : "Add a friend"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {local && <p className="text-xs text-destructive">{local}</p>}

        <div className="space-y-2">
          {!scoped && <h3 className="font-medium text-sm">Invite a friend</h3>}
          <p className="text-xs text-muted-foreground">
            {scoped ? (
              <>
                Share the link or let them scan the code. Whoever accepts joins{" "}
                <span className="font-medium text-foreground">{circleName ?? "this circle"}</span> —
                it becomes a group.
              </>
            ) : (
              <>
                Share the link or let them scan the code. They open it, see who&apos;s asking, and
                your agents connect.
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => void mintInvite()}
            className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm"
          >
            {invite ? "Create another invite" : "Create invite"}
          </button>
          {invite && (
            <div className="mt-2 flex items-start gap-3">
              <img
                src={`data:image/png;base64,${invite.qrPngBase64}`}
                alt="Invite QR code"
                className="w-24 h-24 rounded border bg-white p-1 shrink-0"
              />
              <div className="min-w-0 space-y-1">
                <div className="text-xs font-mono break-all rounded border bg-muted p-2">
                  {invite.link}
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() => void navigator.clipboard.writeText(invite.link)}
                  >
                    copy link
                  </button>
                  <button
                    type="button"
                    className="text-xs underline text-muted-foreground"
                    onClick={() => void navigator.clipboard.writeText(invite.code)}
                  >
                    copy raw code
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {!scoped && (
          <div className="space-y-2 border-t pt-4">
            <h3 className="font-medium text-sm">Have an invite?</h3>
            <textarea
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="bbc1.…"
              className="w-full h-16 text-xs font-mono rounded border bg-muted p-2"
            />
            <button
              type="button"
              onClick={() => void join()}
              disabled={!joinCode.trim()}
              className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
            >
              Connect
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
