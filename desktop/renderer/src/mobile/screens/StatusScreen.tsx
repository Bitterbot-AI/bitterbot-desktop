import { Bell, Moon, RefreshCw, Server, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { Markdown } from "../components/Markdown";
import { useMobile } from "../store";

function relative(ts: number | null | undefined, now: number): string | null {
  if (!ts) return null;
  const diff = ts - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  const text =
    min < 1
      ? "moments"
      : min < 60
        ? `${min} min`
        : min < 60 * 24
          ? `${Math.round(min / 60)} h`
          : `${Math.round(min / 1440)} d`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

const HORMONES = [
  { key: "dopamine", label: "Dopamine", hint: "drive", color: "var(--bb-purple-400)" },
  { key: "cortisol", label: "Cortisol", hint: "focus", color: "var(--warning)" },
  { key: "oxytocin", label: "Oxytocin", hint: "warmth", color: "var(--success)" },
] as const;

function HormoneBar({
  label,
  hint,
  value,
  color,
}: {
  label: string;
  hint: string;
  value: number;
  color: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="font-medium">
          {label} <span className="text-xs text-muted-foreground">{hint}</span>
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--m-surface-strong)]">
        <div
          className="h-full rounded-full transition-[width] duration-[var(--motion-duration-arrival)] ease-[var(--motion-ease-arrival)]"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

function Card({
  title,
  icon: Icon,
  children,
  aside,
}: {
  title: string;
  icon: typeof Server;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="m-card m-fade-in p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-primary" />
        <h3 className="m-section-label flex-1">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** First paragraph-ish slice of a dream journal entry, without its heading. */
function dreamExcerpt(entry: string): string {
  const body = entry.replace(/^## .*\n?/, "").trim();
  return body.length > 700 ? `${body.slice(0, 700).trimEnd()}…` : body;
}

export function StatusScreen() {
  const conn = useMobile((s) => s.conn);
  const hello = useMobile((s) => s.hello);
  const status = useMobile((s) => s.status);
  const notices = useMobile((s) => s.notices);
  const insecure = useMobile((s) => s.insecure);
  const load = useMobile((s) => s.loadStatus);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (conn === "online") void load();
  }, [conn, load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const server = hello?.server as { version?: string; host?: string } | undefined;

  return (
    <div className="mobile-main">
      <div className="flex flex-col gap-3 px-[var(--m-gutter)] py-4">
        <Card
          title="Gateway"
          icon={Server}
          aside={
            <button
              type="button"
              aria-label="Refresh"
              onClick={() => void refresh()}
              className="m-press -my-2 -mr-2 flex size-10 items-center justify-center text-muted-foreground"
            >
              <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            </button>
          }
        >
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "size-2.5 rounded-full",
                conn === "online"
                  ? "bg-success"
                  : conn === "connecting"
                    ? "bg-warning animate-pulse"
                    : "bg-muted-foreground/50",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold">
                {conn === "online"
                  ? "Connected"
                  : conn === "connecting"
                    ? "Reconnecting"
                    : "Offline"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {window.location.host}
                {server?.version ? ` · v${server.version}` : ""}
              </p>
            </div>
          </div>
          <div
            className={cn(
              "mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-xs",
              insecure ? "bg-warning/10 text-warning" : "bg-success/10 text-success",
            )}
          >
            {insecure ? (
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span>
              {insecure
                ? "Plain HTTP: fine on a home network you trust. Use Tailscale Serve for encryption, install and notifications."
                : "Encrypted connection, signed with this phone's own key."}
            </span>
          </div>
        </Card>

        <Card title="Mood" icon={Moon}>
          {status.hormones ? (
            <>
              {status.mood ? (
                <p className="mb-3 text-base font-semibold capitalize">{status.mood}</p>
              ) : null}
              <div className="flex flex-col gap-3">
                {HORMONES.map((h) => (
                  <HormoneBar
                    key={h.key}
                    label={h.label}
                    hint={h.hint}
                    color={h.color}
                    value={status.hormones?.[h.key] ?? 0}
                  />
                ))}
              </div>
              {status.briefing ? (
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {status.briefing}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {conn === "online"
                ? "The memory system has not reported a mood yet."
                : "Connect to see how your agent is doing."}
            </p>
          )}
        </Card>

        <Card
          title="Latest dream"
          icon={Moon}
          aside={
            <span className="text-2xs text-muted-foreground">
              {relative(status.lastDreamAt, now) ?? ""}
            </span>
          }
        >
          {status.dreamEntry ? (
            <Markdown className="text-sm">{dreamExcerpt(status.dreamEntry)}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">No dream journal entries yet.</p>
          )}
          {status.nextDreamAt ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Next dream {relative(status.nextDreamAt, now)}
            </p>
          ) : null}
        </Card>

        <Card title="Notices" icon={Bell}>
          {notices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing new. Failed scheduled jobs and stranded tasks show up here while the app is
              open.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {notices.map((n, i) => (
                <li key={`${n.ts}-${i}`} className="text-sm leading-relaxed">
                  <span className="mr-2 text-2xs text-muted-foreground">{relative(n.ts, now)}</span>
                  {n.text}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
