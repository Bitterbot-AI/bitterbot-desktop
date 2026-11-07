import { CheckCircle2, Loader2, RefreshCw, ShieldAlert, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { describeError } from "../../lib/describe-error";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

/**
 * "Pair a phone" (PLAN-62). Mints a one-time setup code, shows it as a QR
 * code rendered here (no external QR service ever sees the link), then waits
 * for the phone to claim it and shows the six-digit confirmation number. The
 * owner approves only when the phone shows the same number.
 */

type PairUrl = { url: string; label: string; secure: boolean; pairUrl: string };
type CreateResult = {
  code: string;
  setupId: string;
  expiresAtMs: number;
  basePath?: string;
  urls: PairUrl[];
};
type PendingClaim = {
  requestId: string;
  setupId?: string;
  confirmCode?: string;
  displayName?: string;
  platform?: string;
  remoteIp?: string;
};

function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/**
 * This page's own address is a usable option when it is not localhost. The
 * gateway's base path (gateway.controlUi.basePath) is kept, so a Control UI at
 * https://host/bitterbot pairs the phone to https://host/bitterbot/m/.
 */
export function currentOrigin(
  code: string,
  basePath = "",
  loc: Pick<Location, "protocol" | "host" | "origin"> = window.location,
): PairUrl | null {
  if (!/^https?:$/.test(loc.protocol) || isLoopbackHost(loc.host)) {
    return null;
  }
  const path = basePath.replace(/\/+$/, "");
  const base = `${loc.origin}${path.startsWith("/") || !path ? path : `/${path}`}`;
  return {
    url: base,
    label: "This address",
    secure: loc.protocol === "https:",
    pairUrl: `${base}/m/#pair=${encodeURIComponent(code)}`,
  };
}

export function formatConfirm(code?: string): string {
  return code && code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : (code ?? "");
}

export function PairPhoneDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const request = useGatewayStore((s) => s.request);
  const [created, setCreated] = useState<CreateResult | null>(null);
  const [urls, setUrls] = useState<PairUrl[]>([]);
  const [selected, setSelected] = useState(0);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<PendingClaim | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const create = useCallback(async () => {
    setError(null);
    setClaim(null);
    setDone(null);
    setCreated(null);
    setQr(null);
    setCopied(false);
    try {
      const res = await request<CreateResult>("mobile.pair.create", {});
      const own = currentOrigin(res.code, res.basePath);
      const list = [...res.urls];
      if (own && !list.some((u) => u.url === own.url)) list.unshift(own);
      setCreated(res);
      setUrls(list);
      setSelected(0);
    } catch (err) {
      setError(describeError(err));
    }
  }, [request]);

  useEffect(() => {
    if (open) void create();
  }, [open, create]);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    const target = urls[selected]?.pairUrl;
    setCopied(false);
    if (!target) {
      setQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(target, {
      margin: 1,
      width: 480,
      errorCorrectionLevel: "M",
      color: { dark: "#17101f", light: "#ffffff" },
    }).then((url) => {
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [urls, selected]);

  useGatewayEvent(
    "device.pair.requested",
    useCallback(
      (payload: unknown) => {
        const req = payload as PendingClaim;
        if (created && req?.setupId === created.setupId) setClaim(req);
      },
      [created],
    ),
  );

  const decide = async (approve: boolean) => {
    if (!claim) return;
    setBusy(true);
    try {
      await request(approve ? "device.pair.approve" : "device.pair.reject", {
        requestId: claim.requestId,
      });
      if (approve) {
        setDone(claim.displayName ?? "Your phone");
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remaining = created ? Math.max(0, created.expiresAtMs - now) : 0;
  const expired = Boolean(created) && remaining === 0 && !claim && !done;
  const current = urls[selected];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="size-5 text-primary" />
            Pair a phone
          </DialogTitle>
          <DialogDescription>
            Scan with the phone's camera. The link works once, for five minutes, and never carries
            your gateway token.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {done ? (
          <div className="flex flex-col items-center py-6 text-center">
            <CheckCircle2 className="size-10 text-success" />
            <p className="mt-3 text-base font-semibold">{done} is paired</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Rename or remove it any time under Devices.
            </p>
          </div>
        ) : claim ? (
          <div className="flex flex-col items-center py-2 text-center">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{claim.displayName ?? "A phone"}</span>
              {claim.remoteIp ? ` (${claim.remoteIp})` : ""} wants to pair. Its screen should show:
            </p>
            <p className="mt-4 font-mono text-4xl font-semibold tracking-[0.12em] tabular-nums">
              {formatConfirm(claim.confirmCode)}
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              Only approve if the numbers match. If they differ, someone else used the code.
            </p>
            <div className="mt-5 grid w-full grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(false)}
                className="h-10 rounded-lg border border-border text-sm font-medium hover:bg-muted"
              >
                Reject
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(true)}
                className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                Codes match, approve
              </button>
            </div>
          </div>
        ) : created && urls.length === 0 ? (
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
            This gateway only listens on this computer, so a phone cannot reach it. Turn on
            Tailscale Serve (<code>gateway.tailscale.mode: serve</code>), bind to your network (
            <code>gateway.bind: lan</code>), or set <code>gateway.mobile.publicUrl</code>.
          </div>
        ) : (
          <div className="flex flex-col items-center">
            <div
              className={cn(
                "relative flex size-60 items-center justify-center rounded-2xl bg-white p-3 shadow-[var(--shadow-content-edge)]",
                expired && "opacity-30",
              )}
            >
              {qr ? (
                <img src={qr} alt="Pairing QR code" className="size-full" />
              ) : (
                <Loader2 className="size-6 animate-spin text-neutral-400" />
              )}
            </div>
            {urls.length > 1 && (
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {urls.map((u, i) => (
                  <button
                    key={u.url}
                    type="button"
                    onClick={() => setSelected(i)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs",
                      i === selected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {u.label}
                  </button>
                ))}
              </div>
            )}
            {current && (
              <p className="mt-2 max-w-full truncate font-mono text-2xs text-muted-foreground">
                {current.url}
              </p>
            )}
            {current && !expired && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(current.pairUrl).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
                className="mt-2 text-xs font-medium text-primary hover:underline"
              >
                {copied ? "Link copied. It works once, for five minutes." : "Copy link"}
              </button>
            )}
            {current && !current.secure && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                Plain HTTP: anyone on this network could read or change the traffic, so use it only
                on a network you trust. Notifications need HTTPS, such as Tailscale Serve.
              </p>
            )}
            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              {expired ? (
                <button
                  type="button"
                  onClick={() => void create()}
                  className="flex items-center gap-1.5 font-medium text-primary"
                >
                  <RefreshCw className="size-4" />
                  Code expired. Make a new one
                </button>
              ) : created ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Waiting for the phone · {Math.floor(remaining / 60_000)}:
                  {String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0")}
                </>
              ) : null}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
