import {
  AppWindow,
  Check,
  CreditCard,
  Globe,
  Hand,
  Loader2,
  Megaphone,
  ShieldCheck,
  Terminal,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { cn } from "../../lib/utils";
import { useMobile, type ReviewAction } from "../store";

const KIND: Record<string, { label: string; icon: typeof Terminal }> = {
  command: { label: "Run a shell command", icon: Terminal },
  spend: { label: "Make a payment", icon: CreditCard },
  publish: { label: "Post publicly", icon: Megaphone },
  contact: { label: "Message someone new", icon: UserPlus },
  connector: { label: "Act in a connected app", icon: AppWindow },
  handoff: { label: "Take over the browser", icon: Hand },
};

function timeLeft(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expiring";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute left";
  if (min < 60) return `${min} min left`;
  return `${Math.round(min / 60)} h left`;
}

function commandOf(action: ReviewAction): string | null {
  const params = action.params as { command?: unknown; cwd?: unknown } | undefined;
  return typeof params?.command === "string" ? params.command : null;
}

function ApprovalCard({ action, highlighted }: { action: ReviewAction; highlighted: boolean }) {
  const resolve = useMobile((s) => s.resolveApproval);
  const busy = useMobile((s) => s.busyApprovals.has(action.id));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const kind = KIND[action.cls] ?? { label: "Needs your OK", icon: ShieldCheck };
  const Icon = kind.icon;
  const command = action.cls === "command" ? commandOf(action) : null;
  const paymentOnDesktop = action.cls === "spend";

  const decide = async (decision: "approve" | "deny") => {
    const error = await resolve(action.id, decision);
    if (error) {
      toast.error(error);
    } else {
      toast.success(decision === "approve" ? "Approved" : "Denied");
    }
  };

  return (
    <article
      className={cn(
        "m-fade-in overflow-hidden rounded-2xl border bg-[var(--circle-consent-soft)]/60",
        highlighted
          ? "border-[var(--circle-consent)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--circle-consent)_25%,transparent)]"
          : "border-[color-mix(in_oklab,var(--circle-consent)_35%,transparent)]",
      )}
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_oklab,var(--circle-consent)_18%,transparent)] text-[var(--circle-consent)]">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold leading-snug">{kind.label}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {action.tool} · {timeLeft(action.expiresAt, now)}
          </p>
        </div>
      </div>
      <div className="px-4 pb-4">
        {command ? (
          // Wrapped, never scrolled: the owner must see the whole command before approving it.
          <pre className="whitespace-pre-wrap break-all rounded-xl bg-[var(--m-surface-strong)] p-3 font-mono text-xs leading-relaxed text-foreground">
            <code>{command}</code>
          </pre>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {action.preview}
          </p>
        )}
        {paymentOnDesktop && (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Globe className="size-3.5 shrink-0" />
            Payments are approved on your computer for now. You can deny it here.
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-[var(--m-hairline)] p-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("deny")}
          className="m-press m-touch flex items-center justify-center gap-2 rounded-xl bg-[var(--m-surface-strong)] text-sm font-semibold text-foreground disabled:opacity-50"
        >
          <X className="size-4" />
          Deny
        </button>
        <button
          type="button"
          disabled={busy || paymentOnDesktop}
          onClick={() => void decide("approve")}
          className="m-press m-touch flex items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          Approve
        </button>
      </div>
    </article>
  );
}

export function ApprovalsScreen({ focusId }: { focusId: string | null }) {
  const approvals = useMobile((s) => s.approvals);
  const load = useMobile((s) => s.loadApprovals);
  const conn = useMobile((s) => s.conn);
  useEffect(() => {
    if (conn === "online") void load();
  }, [conn, load]);
  const sorted = useMemo(() => {
    const list = [...approvals].toSorted((a, b) => b.createdAt - a.createdAt);
    if (!focusId) return list;
    return [...list.filter((a) => a.id === focusId), ...list.filter((a) => a.id !== focusId)];
  }, [approvals, focusId]);

  if (sorted.length === 0) {
    return (
      <div className="mobile-main">
        <div className="m-fade-in flex h-full flex-col items-center justify-center px-10 text-center">
          <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-[var(--m-surface-strong)]">
            <ShieldCheck className="size-8 text-success" />
          </div>
          <h2 className="text-lg font-semibold">Nothing waiting on you</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            When the agent wants to run a command, message someone new or post in public, it asks
            here first{focusId ? ". That request was already decided." : "."}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="mobile-main">
      <div className="flex flex-col gap-3 px-[var(--m-gutter)] py-4">
        <p className="m-section-label px-1">{sorted.length} waiting</p>
        {sorted.map((a) => (
          <ApprovalCard key={a.id} action={a} highlighted={a.id === focusId} />
        ))}
      </div>
    </div>
  );
}
