import { Laptop, Pencil, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { describeError } from "../../lib/describe-error";
import { formatRelativeTime } from "../../lib/format";
import { useGatewayStore } from "../../stores/gateway-store";
import { formatConfirm } from "./PairPhoneDialog";

/**
 * Paired devices (PLAN-62): every browser, phone and node host that holds a
 * device token. Rename and remove are per device; removing a phone deletes its
 * token and push subscription and disconnects it, and never touches the
 * gateway token.
 */

type DeviceToken = { role: string; scopes?: string[]; revokedAtMs?: number; lastUsedAtMs?: number };
type PairedDevice = {
  deviceId: string;
  displayName?: string;
  label?: string;
  platform?: string;
  clientId?: string;
  scopes?: string[];
  remoteIp?: string;
  tokens?: DeviceToken[];
  approvedAtMs?: number;
};
type PendingDevice = {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  remoteIp?: string;
  confirmCode?: string;
  ts: number;
};

const SCOPE_WORDS: Record<string, string> = {
  "operator.chat": "chat",
  "operator.approvals": "approvals",
  "operator.notifications": "notifications",
  "operator.admin": "full control",
  "operator.read": "read",
  "operator.write": "write",
  "operator.pairing": "pairing",
};

const CLIENT_NAMES: Record<string, string> = {
  "bitterbot-control-ui": "Control UI browser",
  "bitterbot-desktop": "Desktop app",
  "bitterbot-mobile": "Phone",
  cli: "Command line",
  "node-host": "Node host",
};

function describeScopes(scopes: string[] | undefined): string {
  if (!scopes?.length) return "no scopes";
  if (scopes.includes("operator.admin")) return "full control";
  return scopes.map((s) => SCOPE_WORDS[s] ?? s).join(", ");
}

function isPhone(d: { clientId?: string; platform?: string }): boolean {
  return d.clientId === "bitterbot-mobile" || /ios|android/i.test(d.platform ?? "");
}

function DeviceRow({ device, onChanged }: { device: PairedDevice; onChanged: () => void }) {
  const request = useGatewayStore((s) => s.request);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.label || device.displayName || "");
  const [confirming, setConfirming] = useState(false);
  const title =
    device.label ||
    device.displayName ||
    CLIENT_NAMES[device.clientId ?? ""] ||
    device.deviceId.slice(0, 12);
  const lastUsed = device.tokens
    ?.map((t) => t.lastUsedAtMs ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  const revoked = device.tokens?.length ? device.tokens.every((t) => t.revokedAtMs) : false;
  const Icon = isPhone(device) ? Smartphone : Laptop;

  const save = async () => {
    try {
      await request("device.rename", { deviceId: device.deviceId, name });
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error("Rename failed", { description: describeError(err) });
    }
  };
  const remove = async () => {
    try {
      await request("device.remove", { deviceId: device.deviceId });
      toast.success(`${title} removed`);
      onChanged();
    } catch (err) {
      toast.error("Remove failed", { description: describeError(err) });
    }
  };

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                value={name}
                autoFocus
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                  if (e.key === "Escape") setEditing(false);
                }}
                className="h-8 flex-1 rounded-md border border-border bg-transparent px-2 text-sm focus:border-primary focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void save()}
                className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
              >
                Save
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{title}</span>
              {revoked && (
                <span className="rounded bg-danger/10 px-1.5 py-0.5 text-xs text-danger">
                  revoked
                </span>
              )}
            </div>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {describeScopes(device.scopes)}
            {device.platform ? ` · ${device.platform}` : ""}
            {lastUsed ? ` · last seen ${formatRelativeTime(lastUsed)}` : ""}
          </p>
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="Rename"
              onClick={() => setEditing(true)}
              className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Pencil className="size-3.5" />
            </button>
            {confirming ? (
              <button
                type="button"
                onClick={() => void remove()}
                className="rounded-md bg-danger/10 px-2 py-1.5 text-xs font-medium text-danger hover:bg-danger/20"
              >
                Remove?
              </button>
            ) : (
              <button
                type="button"
                aria-label="Remove"
                onClick={() => setConfirming(true)}
                onBlur={() => setTimeout(() => setConfirming(false), 200)}
                className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-danger"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function DevicesSection() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [paired, setPaired] = useState<PairedDevice[]>([]);
  const [pending, setPending] = useState<PendingDevice[]>([]);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    try {
      const res = await request<{ paired?: PairedDevice[]; pending?: PendingDevice[] }>(
        "device.pair.list",
        {},
      );
      setPaired(res.paired ?? []);
      setPending(res.pending ?? []);
    } catch {
      // the toast layer already reported it
    }
  }, [gwStatus, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useGatewayEvent(
    "device.pair.requested",
    useCallback(() => void refresh(), [refresh]),
  );
  useGatewayEvent(
    "device.pair.resolved",
    useCallback(() => void refresh(), [refresh]),
  );

  const decide = async (requestId: string, approve: boolean) => {
    try {
      await request(approve ? "device.pair.approve" : "device.pair.reject", { requestId });
      void refresh();
    } catch (err) {
      toast.error(approve ? "Approve failed" : "Reject failed", {
        description: describeError(err),
      });
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Devices
      </h3>
      {pending.map((req) => (
        <div key={req.requestId} className="rounded-xl border border-warning/30 bg-warning/5 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {req.displayName ?? req.deviceId.slice(0, 12)} wants to pair
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {req.confirmCode ? (
                  <>
                    Code on its screen should be{" "}
                    <span className="font-mono font-semibold text-foreground">
                      {formatConfirm(req.confirmCode)}
                    </span>
                  </>
                ) : (
                  "Device pairing request"
                )}
                {req.remoteIp ? ` · ${req.remoteIp}` : ""} · {formatRelativeTime(req.ts)}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => void decide(req.requestId, true)}
                className="rounded-lg border border-success/20 bg-success/10 px-3 py-1.5 text-xs text-success hover:bg-success/30"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => void decide(req.requestId, false)}
                className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-xs text-danger hover:bg-danger/30"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      ))}
      {paired.length === 0 && pending.length === 0 ? (
        <div className="rounded-xl border border-border/20 bg-card/60 p-6 text-center text-sm text-muted-foreground">
          No paired devices yet. Pair a phone to chat and approve from anywhere.
        </div>
      ) : (
        paired.map((d) => (
          <DeviceRow key={d.deviceId} device={d} onChanged={() => void refresh()} />
        ))
      )}
    </div>
  );
}
