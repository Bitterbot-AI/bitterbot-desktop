import { ExternalLink, Lightbulb, Pause, Play, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { describeError } from "../../lib/describe-error";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

// PLAN-54: what the agent is wondering about, what it went and looked up,
// what it learned (with sources and whether a conversation ever used it),
// and the one switch that stops it. The agent never asks permission for a
// question; this page is where the owner sees everything and says stop.

export type CuriosityStatus = {
  enabled: boolean;
  disabledBy: string | null;
  paused: boolean;
  searchConfigured: boolean;
  intervalMinutes: number;
  maxPerDay: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  today: { attempted: number; budget: number };
  openQuestions: number;
  totals: { learned: number; used: number; roi: number; costUsd: number };
  last30d: { learned: number; used: number; roi: number; costUsd: number };
};

export type CuriosityListing = {
  wondering: Array<{
    id: string;
    type: string;
    description: string;
    priority: number;
    createdAt: number;
    attempts: number;
    lastOutcome: string | null;
    source: string | null;
  }>;
  learned: Array<{
    id: string;
    question: string;
    answer: string;
    confidence: number;
    sources: Array<{ url: string; title: string | null }>;
    createdAt: number;
    usedCount: number;
    firstUsedAt: number | null;
    costUsd: number;
    chunkId: string | null;
    current: boolean;
    verified: boolean;
  }>;
  closed: Array<{ id: string; description: string; outcome: string | null; resolvedAt: number }>;
};

const SOURCE_WORDS: Record<string, string> = {
  working_memory: "from its own reflections",
  weak_search: "you asked and it had nothing",
  owner: "you asked it to find out",
  deep_recall: "a blind spot it noticed",
};

const OUTCOME_WORDS: Record<string, string> = {
  unanswered: "Could not find a solid answer",
  dismissed: "You told it not to bother",
  sensitive_skipped: "Kept off the web (sensitive topic)",
  containment_rejected: "Held back (the search phrase would have revealed too much)",
  no_results: "Nothing readable found",
  inconclusive: "First attempt inconclusive",
};

/** One line on why a question is in the queue, in words. */
export function describeQuestionSource(q: {
  source: string | null;
  attempts: number;
  lastOutcome: string | null;
}): string {
  const src = (q.source && SOURCE_WORDS[q.source]) ?? "noticed while thinking";
  const retry =
    q.attempts > 0 && q.lastOutcome
      ? `; ${OUTCOME_WORDS[q.lastOutcome] ?? q.lastOutcome}, will try again`
      : "";
  return `${src}${retry}`;
}

/** "in 2h", "in 15m", or "soon" for a pass that is due. */
export function describeNextPass(at: number | null, now = Date.now()): string {
  if (!at || at <= now) return "soon";
  const mins = Math.round((at - now) / 60_000);
  return mins >= 60 ? `in ${Math.round(mins / 60)}h` : `in ${Math.max(1, mins)}m`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function CuriosityView() {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [info, setInfo] = useState<CuriosityStatus | null>(null);
  const [listing, setListing] = useState<CuriosityListing | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (status !== "connected") return;
    try {
      const [s, l] = await Promise.all([
        request("curiosity.status", {}) as Promise<CuriosityStatus>,
        request("curiosity.list", { limit: 50 }) as Promise<CuriosityListing>,
      ]);
      setInfo(s);
      setListing(l);
    } catch (err) {
      toast.error(describeError(err));
    }
  }, [status, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (method: string, params: Record<string, unknown> = {}, done?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await request(method, params);
      if (done) toast.success(done);
      await refresh();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const paused = info?.paused === true;
  const off = info ? !info.enabled || !info.searchConfigured : false;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Curiosity</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Questions your agent is wondering about, what it went and looked up on its own, and
            whether any of it came in useful. It never asks first; you can stop it here.
          </p>
        </div>
        {info && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || off}
              onClick={() => {
                void act(
                  "curiosity.runNow",
                  {},
                  "Looking into something now; this takes a few minutes",
                );
                // The pass runs in the background; pick up what it learned.
                setTimeout(() => void refresh(), 60_000);
                setTimeout(() => void refresh(), 180_000);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Research one question now (counts against today's budget)"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Look into something now
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(
                  paused ? "curiosity.resume" : "curiosity.pause",
                  {},
                  paused ? "Curiosity resumed" : "Curiosity paused",
                )
              }
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border",
                paused
                  ? "bg-brand/10 text-brand border-brand/20 hover:bg-brand/30"
                  : "border-warning/30 text-warning bg-warning/10 hover:bg-warning/20",
              )}
            >
              {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              {paused ? "Resume" : "Pause exploring"}
            </button>
          </div>
        )}
      </div>

      {info && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat
            label="State"
            value={
              paused
                ? "Paused"
                : off
                  ? info.searchConfigured
                    ? "Off"
                    : "No web search"
                  : "Exploring"
            }
          />
          <Stat
            label="Today"
            value={`${info.today.attempted} of ${info.today.budget}`}
            hint={`questions; next pass ${describeNextPass(info.nextRunAt)}`}
          />
          <Stat
            label="Learned"
            value={String(info.totals.learned)}
            hint={`${info.totals.used} came in useful (${Math.round(info.totals.roi * 100)}%)`}
          />
          <Stat
            label="Cost, 30 days"
            value={`$${info.last30d.costUsd.toFixed(2)}`}
            hint={`${info.last30d.learned} learned`}
          />
        </div>
      )}

      {off && info && !info.searchConfigured && (
        <div className="p-4 text-sm rounded-xl border border-border/20 bg-card/60 text-muted-foreground">
          Add a web search key under Settings (tools.web.search) and the agent will start looking
          things up on its own.
        </div>
      )}

      {info && !info.enabled && info.disabledBy && (
        <div className="p-4 text-sm rounded-xl border border-border/20 bg-card/60 text-muted-foreground">
          Turned off by <code>{info.disabledBy}: false</code> in your config. Set{" "}
          <code>memory.curiosity.research.enabled: true</code> to turn it on.
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">Wondering about</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const q = question.trim();
            if (q.length < 8) return;
            setQuestion("");
            void act("curiosity.ask", { question: q }, "Added to the queue");
          }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Give it something to find out…"
            className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-border bg-background"
            maxLength={300}
          />
          <button
            type="submit"
            disabled={busy || question.trim().length < 8}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-brand/10 text-brand border border-brand/20 hover:bg-brand/30 disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" /> Ask
          </button>
        </form>
        {listing && listing.wondering.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing in the queue. Questions appear after it dreams, or when a search of yours comes
            up empty.
          </p>
        )}
        <ul className="space-y-1.5">
          {listing?.wondering.map((q) => (
            <li
              key={q.id}
              className="flex items-start gap-3 p-3 rounded-xl border border-border/20 bg-card/60"
            >
              <Lightbulb className="w-4 h-4 mt-0.5 text-brand shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-foreground break-words">{q.description}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {describeQuestionSource(q)} · {formatRelativeTime(q.createdAt)}
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act("curiosity.dismiss", { id: q.id }, "Dismissed")}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Don't bother"
                title="Don't bother"
              >
                <X className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">Learned on its own</h2>
        {listing && listing.learned.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing yet. When it finds a solid, sourced answer it lands here and in memory, and the
            agent mentions it next time you talk.
          </p>
        )}
        <ul className="space-y-1.5">
          {listing?.learned.map((f) => (
            <li
              key={f.id}
              className={cn(
                "p-3 rounded-xl border border-border/20 bg-card/60",
                (!f.current || !f.verified) && "opacity-60",
              )}
            >
              <div className="text-sm font-medium text-foreground break-words">{f.question}</div>
              <div className="text-sm text-foreground/90 mt-1 whitespace-pre-wrap break-words">
                {f.answer}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-2">
                <span>{formatRelativeTime(f.createdAt)}</span>
                <span>confidence {Math.round(f.confidence * 100)}%</span>
                <span>
                  {f.usedCount > 0 ? `came up ${f.usedCount}× in conversation` : "not used yet"}
                </span>
                {f.costUsd > 0 && <span>${f.costUsd.toFixed(3)}</span>}
                {!f.verified && <span>found, but not confident enough to remember</span>}
                {f.verified && !f.current && <span>superseded by a newer answer</span>}
                {f.sources.map((s) => (
                  <a
                    key={s.url}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-brand hover:underline"
                  >
                    <ExternalLink className="w-3 h-3" /> {hostOf(s.url)}
                  </a>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {listing && listing.closed.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Set aside</h2>
          <ul className="space-y-1">
            {listing.closed.map((c) => (
              <li key={c.id} className="text-xs text-muted-foreground break-words">
                {c.description} · {(c.outcome && OUTCOME_WORDS[c.outcome]) ?? c.outcome ?? "closed"}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="p-3 rounded-xl border border-border/20 bg-card/60">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
