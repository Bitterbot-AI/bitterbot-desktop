import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useGatewayStore } from "../../stores/gateway-store";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

interface QrPairingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  label: string;
  accountId?: string;
  onLinked?: () => void;
}

type Phase = "starting" | "scan" | "waiting" | "linked" | "error";

/**
 * QR device-link dialog for QR-capable channels (WhatsApp, Signal).
 * web.login.start {channel} returns the QR as a data URL; web.login.wait
 * blocks until the phone scans it and the gateway brings the channel up.
 */
export function QrPairingDialog({
  open,
  onOpenChange,
  channelId,
  label,
  accountId,
  onLinked,
}: QrPairingDialogProps) {
  const request = useGatewayStore((s) => s.request);
  const [phase, setPhase] = useState<Phase>("starting");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const runRef = useRef(0);
  // Callback props live in refs so parent re-renders (e.g. the refresh that
  // onLinked itself triggers) can NEVER re-fire the flow effect: a restarted
  // flow calls web.login.start, which stops the channel that just linked.
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  const runFlow = useCallback(async () => {
    const run = ++runRef.current;
    setPhase("starting");
    setQrDataUrl(null);
    setMessage("");
    try {
      const start = await request<{ qrDataUrl?: string; message?: string }>(
        "web.login.start",
        { channel: channelId, ...(accountId ? { accountId } : {}) },
        { timeoutMs: 60_000 },
      );
      if (run !== runRef.current) return;
      if (!start?.qrDataUrl) {
        setPhase("error");
        setMessage(start?.message ?? "The gateway did not return a QR code.");
        return;
      }
      setQrDataUrl(start.qrDataUrl);
      setMessage(start.message ?? "Scan the QR with your phone.");
      setPhase("scan");

      const wait = await request<{ connected?: boolean; message?: string }>(
        "web.login.wait",
        { channel: channelId, ...(accountId ? { accountId } : {}), timeoutMs: 120_000 },
        { timeoutMs: 150_000 },
      );
      if (run !== runRef.current) return;
      if (wait?.connected) {
        setPhase("linked");
        setMessage(wait.message ?? "Linked.");
        toast.success(`${label} linked`, { description: wait.message });
        onLinkedRef.current?.();
      } else {
        setPhase("error");
        setMessage(wait?.message ?? "Linking did not complete.");
      }
    } catch (err) {
      if (run !== runRef.current) return;
      setPhase("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [channelId, accountId, label, request]);

  useEffect(() => {
    if (!open) {
      // Invalidate any in-flight run so a stale response can't mutate state.
      runRef.current += 1;
      return;
    }
    void runFlow();
    // runFlow's deps are stable for a given target (channelId/accountId);
    // the flow starts once per open, not once per parent render.
  }, [open, runFlow]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>Link {label}</DialogTitle>
          <DialogDescription>
            {channelId === "signal"
              ? "Signal → Settings → Linked Devices → Link New Device."
              : "WhatsApp → Settings → Linked Devices → Link a Device."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 py-2">
          {phase === "starting" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Generating QR…
            </div>
          )}
          {qrDataUrl && phase !== "error" && (
            <img
              src={qrDataUrl}
              alt={`${label} pairing QR code`}
              className="w-56 h-56 rounded-md bg-white p-2"
            />
          )}
          {phase === "scan" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Waiting for scan…
            </div>
          )}
          {phase === "linked" && <p className="text-sm text-success">{message}</p>}
          {phase === "error" && (
            <div className="space-y-2 text-center">
              <p className="text-sm text-danger">{message}</p>
              <button
                onClick={() => void runFlow()}
                className="text-xs px-2 py-1 rounded border border-border hover:bg-muted/90"
              >
                Try again
              </button>
            </div>
          )}
          {phase === "scan" && message && (
            <p className="text-xs text-muted-foreground text-center">{message}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
