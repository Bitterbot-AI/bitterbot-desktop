import { X } from "lucide-react";
import { useCallback, useState } from "react";
import { memberName, useCirclesStore } from "../../stores/circles-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { InviteTrustPrompt, type InvitePreview } from "./InviteTrustPrompt";

// PLAN-36 Phase A → Phase B (lifecycle): the modal behind the rail's "+".
//
// Two modes. SCOPED (circleId set): mint an invite that grows an EXISTING
// circle. DEFAULT (no circleId): start a NEW circle — name it up front
// (optional; the name's leading emoji becomes its tile), then mint an invite
// for it. The first mint creates the circle ONCE and every further mint
// reuses it — "New invite code" can never silently mint another circle
// (the old "Create another invite" bug). "Create without inviting" makes a
// solo circle (canvas + practice partner) with no invite at all.
//
// Joining pastes a code — which now runs the SAME signature-verified
// inviteInfo preview as the in-message Join path before anything joins
// (Phase B join parity): you always see who is REALLY asking first.

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
  const circles = useCirclesStore((s) => s.circles);
  const createCircle = useCirclesStore((s) => s.createCircle);
  const inviteInfo = useCirclesStore((s) => s.inviteInfo);
  const scoped = !!circleId;

  // "Add someone you know": every peer from your other circles who isn't
  // already in THIS one. Names resolve petname-first (your labels).
  const knownConnections = (() => {
    if (!scoped) return [];
    const current = new Set(
      (circles.find((c) => c.circleId === circleId)?.members ?? []).map((m) => m.memberPubkey),
    );
    const seen = new Map<string, string>();
    for (const c of circles) {
      if (c.status !== "active") continue;
      for (const m of c.members) {
        if (m.isSelf || current.has(m.memberPubkey) || seen.has(m.memberPubkey)) continue;
        seen.set(m.memberPubkey, memberName(m));
      }
    }
    return [...seen.entries()].map(([pubkey, name]) => ({ pubkey, name }));
  })();
  const [pickedPubkey, setPickedPubkey] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "queued">("idle");

  const sendToConnection = useCallback(async () => {
    if (!pickedPubkey || sendState === "sending") return;
    setSendState("sending");
    try {
      const res = await request<{ delivered?: string[] }>("circles.invite", {
        circleId,
        sendToPubkey: pickedPubkey,
      });
      setSendState((res.delivered?.length ?? 0) > 0 ? "sent" : "queued");
      void refresh();
    } catch (err) {
      setSendState("idle");
      setLocal(String(err));
    }
  }, [request, circleId, pickedPubkey, sendState, refresh]);

  const [invite, setInvite] = useState<{ code: string; link: string; qrPngBase64: string } | null>(
    null,
  );
  // Phase B: the circle the FIRST mint created — every further mint reuses it.
  const [mintedCircleId, setMintedCircleId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinPreview, setJoinPreview] = useState<InvitePreview | null>(null);
  const [joining, setJoining] = useState(false);
  const [local, setLocal] = useState<string | null>(null);

  const mintInvite = useCallback(async () => {
    try {
      // Scoped → the given circle. Unscoped → the circle the first mint
      // created, else a fresh one carrying the typed name (server names it
      // "<you> & friend" when blank).
      const target = circleId ?? mintedCircleId;
      const params = target ? { circleId: target } : newName.trim() ? { name: newName.trim() } : {};
      const res = await request<{
        code: string;
        link: string;
        qrPngBase64: string;
        circleId?: string;
      }>("circles.invite", params);
      setInvite({ code: res.code, link: res.link, qrPngBase64: res.qrPngBase64 });
      if (!scoped && !mintedCircleId && typeof res.circleId === "string") {
        setMintedCircleId(res.circleId);
      }
      void refresh();
    } catch (err) {
      setLocal(String(err));
    }
  }, [request, refresh, circleId, mintedCircleId, newName, scoped]);

  const createOnly = useCallback(async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    const created = await createCircle(newName);
    setCreating(false);
    if (created) onClose();
  }, [newName, creating, createCircle, onClose]);

  // Join parity: verify the code's signer FIRST — same prompt as the
  // in-message Join path. Only the explicit Join tap redeems.
  const previewJoin = useCallback(async () => {
    const code = joinCode.trim();
    if (!code) return;
    const info = await inviteInfo(code);
    if (info) setJoinPreview({ code, ...info });
  }, [joinCode, inviteInfo]);

  const join = useCallback(async () => {
    if (!joinPreview || joining) return;
    setJoining(true);
    try {
      const res = await request<{
        circleName: string;
        inviterName: string | null;
        status?: "connected" | "pending";
      }>("circles.join", { code: joinPreview.code });
      const by = res.inviterName ? ` (invited by ${res.inviterName})` : "";
      setNotice(
        res.status === "pending"
          ? `Request sent to ${res.circleName}${by}. You'll connect as soon as they're online.`
          : `Connected: ${res.circleName}${by}`,
      );
      setJoinCode("");
      setJoinPreview(null);
      void refresh();
      onClose();
    } catch (err) {
      setJoinPreview(null);
      setLocal(String(err));
    } finally {
      setJoining(false);
    }
  }, [request, joinPreview, joining, refresh, setNotice, onClose]);

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
            {scoped ? `Invite to ${circleName ?? "this circle"}` : "New circle"}
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

        {scoped && knownConnections.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-medium text-sm">Add someone you know</h3>
            <p className="text-xs text-muted-foreground">
              The invite is delivered through a circle you already share — they tap Join on their
              side.
            </p>
            {sendState === "sent" || sendState === "queued" ? (
              <p className="text-xs text-circle-you font-medium">
                {sendState === "sent"
                  ? "Invite sent. They'll see it in your shared circle and can join with one tap."
                  : "Invite queued — they're unreachable right now; it will deliver when their node is back."}
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  value={pickedPubkey}
                  onChange={(e) => setPickedPubkey(e.target.value)}
                  aria-label="Choose a connection"
                  className="flex-1 min-w-0 rounded border bg-background text-foreground text-sm px-2 py-1.5"
                >
                  <option value="">Choose a connection…</option>
                  {knownConnections.map((k) => (
                    <option key={k.pubkey} value={k.pubkey}>
                      {k.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void sendToConnection()}
                  disabled={!pickedPubkey || sendState === "sending"}
                  className="px-3 py-1.5 rounded bg-circle-you text-circle-you-fg text-sm disabled:opacity-50 shrink-0"
                >
                  {sendState === "sending" ? "Sending…" : "Send invite"}
                </button>
              </div>
            )}
            <div className="border-t pt-2 text-xs text-muted-foreground">
              Or invite someone new with a link:
            </div>
          </div>
        )}

        <div className="space-y-2">
          {!scoped && (
            <>
              <label className="block space-y-1">
                <span className="font-medium text-sm">Name it</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  disabled={!!mintedCircleId}
                  maxLength={80}
                  placeholder="🏔️ Tahoe trip — a leading emoji becomes the tile"
                  aria-label="Circle name"
                  className="w-full rounded border bg-background text-sm px-2.5 py-1.5 disabled:opacity-60"
                />
              </label>
              {mintedCircleId && (
                <p className="text-badge text-muted-foreground">
                  Circle created — rename it anytime from its tile menu.
                </p>
              )}
            </>
          )}
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
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void mintInvite()}
              className="px-3 py-1.5 rounded bg-circle-you text-circle-you-fg text-sm"
            >
              {invite ? "New invite code" : "Create invite"}
            </button>
            {!scoped && !invite && (
              <button
                type="button"
                onClick={() => void createOnly()}
                disabled={!newName.trim() || creating}
                title="Make the circle now and invite people later — you get its canvas and a practice partner"
                className="text-xs underline text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:no-underline"
              >
                {creating ? "Creating…" : "Create without inviting"}
              </button>
            )}
          </div>
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
            {joinPreview ? (
              <InviteTrustPrompt
                preview={joinPreview}
                busy={joining}
                onCancel={() => setJoinPreview(null)}
                onJoin={() => void join()}
              />
            ) : (
              <>
                <textarea
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="bbc1.…"
                  className="w-full h-16 text-xs font-mono rounded border bg-muted p-2"
                />
                <button
                  type="button"
                  onClick={() => void previewJoin()}
                  disabled={!joinCode.trim()}
                  className="px-3 py-1.5 rounded bg-circle-you text-circle-you-fg text-sm disabled:opacity-50"
                >
                  Check invite
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
