import { Check, Coins, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
/**
 * PLAN-48: Spend Grants & Approvals — the human-facing consent surface.
 *
 * Pending escalations (out-of-scope spends the agent paused on) surface here for
 * one-tap approve/deny; the owner sets and revokes the standing spend budgets the
 * agent operates within. The "scope once, escalate out-of-scope" model, made
 * operable. Talks to the spendGrant.* gateway RPCs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { describeError } from "../../lib/describe-error";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import {
  useSpendGrantsStore,
  type SpendApproval,
  type SpendGrantRow,
} from "../../stores/spend-grants-store";
import { EnableFlagButton } from "../config/EnableFlagButton";

const DAY = 86_400;

function fmtUsd(amount: string | number): string {
  const n = typeof amount === "number" ? amount : Number.parseFloat(amount);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "$?";
}
function fmtPeriod(sec: number): string {
  if (sec === DAY) return "day";
  if (sec === DAY * 7) return "week";
  if (sec === 3600) return "hour";
  if (sec % DAY === 0) return `${sec / DAY} days`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  return `${sec}s`;
}
function fmtPayee(a: string): string {
  if (a === "*") return "any payee";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function fmtDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function ApprovalCard({
  approval,
  onApprove,
  onDeny,
  busy,
}: {
  approval: SpendApproval;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-lg font-semibold text-foreground">
            {fmtUsd(approval.amountUsd)}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              to {fmtPayee(approval.payee)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate">{approval.reason}</p>
          <p className="text-2xs text-muted-foreground/70 mt-0.5">{fmtAgo(approval.createdAt)}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => onApprove(approval.approvalId)}
            disabled={busy}
            className={cn(
              "flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium transition-colors",
              "bg-success text-white hover:bg-success/90 disabled:opacity-50",
            )}
          >
            <Check className="h-3.5 w-3.5" /> Approve
          </button>
          <button
            onClick={() => onDeny(approval.approvalId)}
            disabled={busy}
            className={cn(
              "flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg transition-colors",
              "bg-danger/10 text-danger hover:bg-danger/30 border border-danger/20 disabled:opacity-50",
            )}
          >
            <X className="h-3.5 w-3.5" /> Deny
          </button>
        </div>
      </div>
    </div>
  );
}

function GrantRow({
  grant,
  onRevoke,
  busy,
}: {
  grant: SpendGrantRow;
  onRevoke: (id: string) => void;
  busy: boolean;
}) {
  const payees = grant.scope.allowed_payees.map(fmtPayee).join(", ");
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium text-foreground">
          {fmtUsd(grant.allowance.amount)}{" "}
          <span className="text-muted-foreground">/ {fmtPeriod(grant.period_seconds)}</span>
          {grant.per_tx_max && (
            <span className="text-xs text-muted-foreground">
              {" "}
              · max {fmtUsd(grant.per_tx_max.amount)}/tx
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">to {payees}</p>
        <p className="text-2xs text-muted-foreground/70">expires {fmtDate(grant.exp)}</p>
      </div>
      <button
        onClick={() => onRevoke(grant.grant_id)}
        disabled={busy}
        className={cn(
          "flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg transition-colors flex-shrink-0",
          "bg-danger/10 text-danger hover:bg-danger/30 border border-danger/20 disabled:opacity-50",
        )}
      >
        <Trash2 className="h-3.5 w-3.5" /> Revoke
      </button>
    </div>
  );
}

function AddGrantForm({
  onAdd,
  busy,
}: {
  onAdd: (p: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [payees, setPayees] = useState("");
  const [allowanceUsd, setAllowanceUsd] = useState("");
  const [perTxUsd, setPerTxUsd] = useState("");
  const [periodDays, setPeriodDays] = useState("1");
  const [ttlDays, setTtlDays] = useState("30");

  const input = cn(
    "h-8 px-3 text-sm rounded-lg border bg-transparent w-full",
    "border-border/30 focus:border-brand focus:outline-none",
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const list = payees
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onAdd({
      payees: list.length > 0 ? list : ["*"],
      allowanceUsd: Number(allowanceUsd),
      periodSeconds: Math.max(1, Math.round(Number(periodDays) * DAY)),
      ...(perTxUsd ? { perTxUsd: Number(perTxUsd) } : {}),
      ttlMs: Math.max(1, Math.round(Number(ttlDays) * DAY * 1000)),
    });
    setAllowanceUsd("");
    setPerTxUsd("");
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-3"
    >
      <h3 className="text-sm font-medium text-foreground">Create a spend grant</h3>
      <div>
        <label className="text-xs text-muted-foreground">
          Payees (comma-separated addresses, or blank for any)
        </label>
        <input
          value={payees}
          onChange={(e) => setPayees(e.target.value)}
          placeholder="0x… , 0x…  (blank = *)"
          className={input}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground">Allowance (USD / period)</label>
          <input
            value={allowanceUsd}
            onChange={(e) => setAllowanceUsd(e.target.value)}
            type="number"
            min="0"
            step="0.01"
            placeholder="5.00"
            className={input}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Max per transaction (optional)</label>
          <input
            value={perTxUsd}
            onChange={(e) => setPerTxUsd(e.target.value)}
            type="number"
            min="0"
            step="0.01"
            placeholder="1.00"
            className={input}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Period (days)</label>
          <input
            value={periodDays}
            onChange={(e) => setPeriodDays(e.target.value)}
            type="number"
            min="0"
            step="0.5"
            className={input}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Expires in (days)</label>
          <input
            value={ttlDays}
            onChange={(e) => setTtlDays(e.target.value)}
            type="number"
            min="1"
            step="1"
            className={input}
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={busy || !allowanceUsd || Number(allowanceUsd) <= 0}
        className={cn(
          "px-4 py-1.5 text-xs rounded-lg font-medium transition-colors",
          "bg-brand text-white hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        Create Grant
      </button>
    </form>
  );
}

export function SpendGrantsView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const grants = useSpendGrantsStore((s) => s.grants);
  const approvals = useSpendGrantsStore((s) => s.approvals);
  const grantsRequired = useSpendGrantsStore((s) => s.grantsRequired);
  const loading = useSpendGrantsStore((s) => s.loading);
  const error = useSpendGrantsStore((s) => s.error);
  const { setGrants, setApprovals, setGrantsRequired, setLoading, setError } =
    useSpendGrantsStore.getState();
  const [busy, setBusy] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    try {
      const [gRes, aRes, cRes] = await Promise.allSettled([
        request("spendGrant.list", {}) as Promise<{ grants?: SpendGrantRow[] }>,
        request("spendGrant.approvals", { status: "pending" }) as Promise<{
          approvals?: SpendApproval[];
        }>,
        request("config.get", {}) as Promise<{ config?: Record<string, unknown> }>,
      ]);
      if (gRes.status === "fulfilled") setGrants(gRes.value?.grants ?? []);
      if (aRes.status === "fulfilled") setApprovals(aRes.value?.approvals ?? []);
      if (cRes.status === "fulfilled") {
        const cfg = cRes.value?.config as
          | { a2a?: { payment?: { consent?: { grantsRequired?: boolean } } } }
          | undefined;
        setGrantsRequired(cfg?.a2a?.payment?.consent?.grantsRequired === true);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load spend grants");
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request, setGrants, setApprovals, setGrantsRequired, setLoading, setError]);

  useEffect(() => {
    void refresh();
    // Poll so a newly-raised escalation appears without a manual refresh.
    intervalRef.current = setInterval(() => void refresh(), 15_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh]);

  const act = useCallback(
    async (method: string, params: Record<string, unknown>, ok: string) => {
      setBusy(true);
      try {
        await request(method, params);
        toast.success(ok);
        await refresh();
      } catch (err) {
        toast.error("Action failed", { description: describeError(err) });
      } finally {
        setBusy(false);
      }
    },
    [request, refresh],
  );

  const handleAdd = useCallback(
    (params: Record<string, unknown>) => void act("spendGrant.set", params, "Grant created"),
    [act],
  );

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Coins className="h-6 w-6 text-brand" /> Spend Grants
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Set the budget your agent spends within. Out-of-scope spends pause here for your
            approval.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors",
            "bg-brand/10 text-brand hover:bg-brand/30 border border-brand/20",
            loading && "opacity-50",
          )}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {/* Enforcement status + toggle */}
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldCheck
            className={cn(
              "h-5 w-5 flex-shrink-0",
              grantsRequired ? "text-success" : "text-muted-foreground",
            )}
          />
          <div>
            <p className="text-sm font-medium text-foreground">
              {grantsRequired ? "Grants required" : "Grants optional"}
            </p>
            <p className="text-xs text-muted-foreground">
              {grantsRequired
                ? "Spends without a covering grant are paused for your approval."
                : "The agent may spend within its caps even without a grant. Turn this on to require approval for out-of-scope spends."}
            </p>
          </div>
        </div>
        <EnableFlagButton
          patch={{ a2a: { payment: { consent: { grantsRequired: !grantsRequired } } } }}
          label={grantsRequired ? "Make optional" : "Require grants"}
          onDone={() => void refresh()}
        />
      </div>

      {/* Pending approvals — the escalation surface, most urgent */}
      {approvals.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">
            Awaiting your approval <span className="text-warning">({approvals.length})</span>
          </h2>
          {approvals.map((a) => (
            <ApprovalCard
              key={a.approvalId}
              approval={a}
              busy={busy}
              onApprove={(id) =>
                void act(
                  "spendGrant.approve",
                  { approvalId: id },
                  "Approved — the agent can proceed",
                )
              }
              onDeny={(id) => void act("spendGrant.deny", { approvalId: id }, "Denied")}
            />
          ))}
        </section>
      )}

      {/* Active grants */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">Active grants</h2>
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground rounded-xl border border-border/20 bg-card/40 p-4">
            No active grants. Create one below to let your agent spend autonomously within a budget.
          </p>
        ) : (
          grants.map((g) => (
            <GrantRow
              key={g.grant_id}
              grant={g}
              busy={busy}
              onRevoke={(id) => void act("spendGrant.revoke", { grantId: id }, "Grant revoked")}
            />
          ))
        )}
      </section>

      <AddGrantForm onAdd={handleAdd} busy={busy} />
    </div>
  );
}
