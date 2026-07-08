/**
 * PLAN-31 C2 §4.4: the People pane — the connected graph made visible.
 *
 * Surfaces (in the plan's order of importance):
 *  - The friend-node count, front and center: how many people's agents
 *    yours is connected to. Shown as the ambient signal; the OPTIMIZED
 *    metric is reciprocity (§9), surfaced beside it.
 *  - Presence/liveness per connection ("your people are here"), last-seen.
 *  - Reciprocity + conversation health: reciprocated threads, never a
 *    broadcast-follower race. No public leaderboard, no global count.
 *  - The circles themselves: members, the shared tab's fold, the
 *    conversation buffer (inbound is wrapped + labeled), ask-your-people.
 *  - Invite (mint a code, shown ONCE) and Join (paste a code).
 *  - The latest weekly briefing.
 *
 * Everything is driven by the circles.* gateway RPCs and hidden behind the
 * circles.enabled kill switch — a disabled node sees the explainer.
 */

import { RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

interface CircleMemberRow {
  memberPubkey: string;
  displayName: string | null;
  role: string;
  isSelf: boolean;
  lastSeenAt: number | null;
  lastStatus: string | null;
}

interface CircleRow {
  circleId: string;
  name: string;
  kind: string;
  status: string;
  members: CircleMemberRow[];
}

interface StatusPayload {
  enabled: boolean;
  pubkey?: string;
  connectionCount?: number;
  reciprocity?: { reciprocatedPeers: number; activePeers: number };
  a2aPublicUrl?: string | null;
}

interface MessageRow {
  messageId: string;
  authorPubkey: string;
  direction: string;
  kind: string;
  content: string;
  createdAt: number;
}

interface TabBalancesPayload {
  net: Record<string, number>;
  pairwise: Record<string, Record<string, number>>;
  expenses: number;
  totalCents: number;
}

function fmtLastSeen(ts: number | null): string {
  if (!ts) return "never seen";
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 5) return "online";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

function usd(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function shortKey(pubkey: string): string {
  return pubkey.replace(/^ed25519:/, "").slice(0, 8);
}

function memberName(members: CircleMemberRow[], pubkey: string): string {
  const m = members.find((x) => x.memberPubkey === pubkey);
  if (m?.isSelf) return "you";
  return m?.displayName ?? shortKey(pubkey);
}

export function PeopleView() {
  const request = useGatewayStore((s) => s.request);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [circles, setCircles] = useState<CircleRow[]>([]);
  const [briefing, setBriefing] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await request<StatusPayload>("circles.status", {});
      setStatus(s);
      if (s.enabled) {
        const list = await request<{ circles: CircleRow[] }>("circles.list", {});
        setCircles(list.circles ?? []);
        const b = await request<{ briefing: { content: string } | null }>("circles.briefing", {});
        setBriefing(b.briefing?.content ?? null);
      }
    } catch (err) {
      setNotice(String(err));
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const mintInvite = useCallback(async () => {
    try {
      const res = await request<{ code: string }>("circles.invite", {});
      setInviteCode(res.code);
      void refresh();
    } catch (err) {
      setNotice(String(err));
    }
  }, [request, refresh]);

  const join = useCallback(async () => {
    if (!joinCode.trim()) return;
    try {
      const res = await request<{ circleName: string; inviterName: string | null }>(
        "circles.join",
        { code: joinCode.trim() },
      );
      setNotice(
        `Connected: ${res.circleName}${res.inviterName ? ` (invited by ${res.inviterName})` : ""}`,
      );
      setJoinCode("");
      void refresh();
    } catch (err) {
      setNotice(String(err));
    }
  }, [request, joinCode, refresh]);

  if (loading) {
    return <div className="p-8 text-muted-foreground">Loading your people…</div>;
  }

  if (!status?.enabled) {
    return (
      <div className="p-8 max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="w-6 h-6" /> People
        </h1>
        <p className="text-muted-foreground">
          Circles are not enabled on this node. Your agent can connect with your friends&apos;
          agents — mutually invited, cryptographically paired, private by construction. No feed, no
          follower counts, no money.
        </p>
        <p className="text-sm text-muted-foreground">
          To turn it on, set <code className="font-mono">circles.enabled = true</code> and{" "}
          <code className="font-mono">circles.a2aPublicUrl</code> in your config (PLAN-31 ships dark
          until the security review; enabling is a deliberate act).
        </p>
      </div>
    );
  }

  const recip = status.reciprocity ?? { reciprocatedPeers: 0, activePeers: 0 };

  return (
    <div className="p-6 overflow-y-auto h-full space-y-6">
      {/* Headline: friend-node count + reciprocity health */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Users className="w-6 h-6" /> People
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your agent, connected to the people you chose. Private by construction.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="p-2 rounded hover:bg-muted"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-lg border p-4">
          <div className="text-4xl font-bold">{status.connectionCount ?? 0}</div>
          <div className="text-sm text-muted-foreground">
            people&apos;s agents connected to yours
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-4xl font-bold">{recip.reciprocatedPeers}</div>
          <div className="text-sm text-muted-foreground">reciprocated conversations this week</div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-4xl font-bold">
            {recip.activePeers > 0
              ? `${Math.round((recip.reciprocatedPeers / recip.activePeers) * 100)}%`
              : "—"}
          </div>
          <div className="text-sm text-muted-foreground">of active threads went both ways</div>
        </div>
      </div>

      {notice && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          {notice}
          <button type="button" className="ml-3 underline" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      {/* Invite + join */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border p-4 space-y-2">
          <h2 className="font-medium">Invite a friend</h2>
          <p className="text-xs text-muted-foreground">
            Mints a one-time code (shown once, never stored). Your friend pastes it in their
            Bitterbot and your agents are connected.
          </p>
          <button
            type="button"
            onClick={() => void mintInvite()}
            className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm"
          >
            Create invite code
          </button>
          {inviteCode && (
            <div className="mt-2 space-y-1">
              <textarea
                readOnly
                value={inviteCode}
                className="w-full h-20 text-xs font-mono rounded border bg-muted p-2"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                className="text-xs underline"
                onClick={() => void navigator.clipboard.writeText(inviteCode)}
              >
                copy to clipboard
              </button>
            </div>
          )}
        </div>
        <div className="rounded-lg border p-4 space-y-2">
          <h2 className="font-medium">Have an invite?</h2>
          <p className="text-xs text-muted-foreground">
            Paste the code a friend sent you. You&apos;ll see who&apos;s asking before anything
            connects.
          </p>
          <textarea
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="bbc1.…"
            className="w-full h-20 text-xs font-mono rounded border bg-muted p-2"
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
      </div>

      {/* Circles */}
      <div className="space-y-4">
        {circles.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No connections yet. Invite someone — or say hello to the Practice Partner in chat to see
            how it works.
          </p>
        )}
        {circles.map((c) => (
          <CircleCard key={c.circleId} circle={c} />
        ))}
      </div>

      {/* Briefing */}
      {briefing && (
        <div className="rounded-lg border p-4">
          <h2 className="font-medium mb-2">This week&apos;s briefing</h2>
          <pre className="whitespace-pre-wrap text-sm text-muted-foreground font-sans">
            {briefing}
          </pre>
        </div>
      )}
    </div>
  );
}

function CircleCard({ circle }: { circle: CircleRow }) {
  const request = useGatewayStore((s) => s.request);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [balances, setBalances] = useState<TabBalancesPayload | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const m = await request<{ messages: MessageRow[] }>("circles.messages", {
        circleId: circle.circleId,
        limit: 30,
      });
      setMessages(m.messages ?? []);
      const b = await request<TabBalancesPayload>("circles.tab.balances", {
        circleId: circle.circleId,
      });
      setBalances(b);
    } catch {
      // pane stays usable without details
    }
  }, [request, circle.circleId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const send = useCallback(async () => {
    if (!draft.trim()) return;
    try {
      await request("circles.send", { circleId: circle.circleId, text: draft.trim() });
      setDraft("");
      void load();
    } catch {
      // errors surface via the messages refresh
    }
  }, [request, circle.circleId, draft, load]);

  const peers = circle.members.filter((m) => !m.isSelf);

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium">{circle.name}</span>
          <span className="text-xs rounded bg-muted px-1.5 py-0.5">{circle.kind}</span>
          {circle.status === "frozen" && (
            <span className="text-xs rounded bg-red-500/20 text-red-500 px-1.5 py-0.5">
              FROZEN — ledger fork needs review
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {peers.map((m) => {
            const online = m.lastSeenAt && Date.now() - m.lastSeenAt < 10 * 60_000;
            return (
              <span key={m.memberPubkey} className="flex items-center gap-1 text-xs">
                <span
                  className={cn(
                    "inline-block w-2 h-2 rounded-full",
                    online ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                />
                {m.displayName ?? shortKey(m.memberPubkey)}
                <span className="text-muted-foreground">({fmtLastSeen(m.lastSeenAt)})</span>
              </span>
            );
          })}
        </div>
      </button>
      {open && (
        <div className="border-t px-4 py-3 space-y-3">
          {balances && balances.expenses > 0 && (
            <div className="text-sm">
              <span className="font-medium">The tab:</span> {balances.expenses} expense(s),{" "}
              {usd(balances.totalCents)} total.{" "}
              {Object.entries(balances.pairwise)
                .flatMap(([debtor, creditors]) =>
                  Object.entries(creditors).map(
                    ([creditor, cents]) =>
                      `${memberName(circle.members, debtor)} is ${usd(cents)} behind ${memberName(circle.members, creditor)}`,
                  ),
                )
                .join("; ") || "All square."}
            </div>
          )}
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {messages.length === 0 && (
              <p className="text-xs text-muted-foreground">No agent conversation yet.</p>
            )}
            {[...messages].reverse().map((m) => (
              <div key={m.messageId} className="text-xs">
                <span
                  className={cn(
                    "font-mono",
                    m.direction === "out" ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {m.direction === "out"
                    ? "your agent"
                    : memberName(circle.members, m.authorPubkey)}
                  {" · "}
                  {m.kind}
                  {" — "}
                </span>
                {/* Inbound content is the WRAPPED text; show the label, keep it visibly foreign. */}
                <span className="whitespace-pre-wrap break-words">
                  {m.content.length > 400 ? `${m.content.slice(0, 400)}…` : m.content}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
              placeholder="Say something through your agent…"
              className="flex-1 rounded border bg-muted px-2 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!draft.trim()}
              className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
