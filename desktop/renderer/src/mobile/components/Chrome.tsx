import { Activity, ChevronDown, MessageCircle, Settings, ShieldCheck, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { BitterBotAvatar } from "../../components/chat/BitterBotAvatar";
import { cn } from "../../lib/utils";
import { navigate, type Tab } from "../route";
import { useMobile } from "../store";

export const AVATAR_SRC = "./icons/avatar-128.png";

/** "bitter" in the text color, "bot" in the brand purple: the wordmark. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-semibold tracking-tight", className)}>
      bitter<span className="text-primary">bot</span>
    </span>
  );
}

function ConnectionDot() {
  const conn = useMobile((s) => s.conn);
  return (
    <span
      aria-label={
        conn === "online" ? "Connected" : conn === "connecting" ? "Reconnecting" : "Offline"
      }
      className={cn(
        "inline-block size-2 rounded-full transition-colors",
        conn === "online" && "bg-success",
        conn === "connecting" && "bg-warning animate-pulse",
        conn === "offline" && "bg-muted-foreground/50",
      )}
    />
  );
}

export function sessionTitle(
  key: string,
  rows: { key: string; label?: string; derivedTitle?: string; displayName?: string }[],
) {
  const row = rows.find((r) => r.key === key || r.key.endsWith(`:${key}`));
  if (row?.label) return row.label;
  // The main conversation keeps one friendly name whatever the store derives.
  if (/(^|:)(default|main)$/.test(key)) return "Main chat";
  const title = row?.derivedTitle || row?.displayName;
  if (title) return title;
  return key.replace(/^agent:[^:]+:/, "");
}

export function Header({ tab, onOpenSessions }: { tab: Tab; onOpenSessions: () => void }) {
  const sessionKey = useMobile((s) => s.sessionKey);
  const sessions = useMobile((s) => s.sessions);
  const running = useMobile((s) => Boolean(s.run));
  const titles: Record<Tab, string> = {
    chat: sessionTitle(sessionKey, sessions),
    approvals: "Approvals",
    status: "Status",
    settings: "Settings",
  };
  return (
    <header className="mobile-header">
      <div className="mobile-header-row flex items-center gap-3 px-[var(--m-gutter)]">
        <BitterBotAvatar size={30} src={AVATAR_SRC} isThinking={running} />
        {tab === "chat" ? (
          <button
            type="button"
            onClick={onOpenSessions}
            className="m-press flex min-w-0 flex-1 items-center gap-1.5 text-left"
            aria-label="Switch conversation"
          >
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold leading-tight">
                {titles.chat}
              </span>
              <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                <ConnectionDot />
                <Wordmark className="font-medium" />
              </span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold leading-tight">
              {titles[tab]}
            </span>
            <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <ConnectionDot />
              <Wordmark className="font-medium" />
            </span>
          </div>
        )}
      </div>
    </header>
  );
}

export function TabBar({ tab }: { tab: Tab }) {
  const approvals = useMobile((s) => s.approvals.length);
  const items: Array<{ id: Tab; label: string; icon: typeof MessageCircle; badge?: number }> = [
    { id: "chat", label: "Chat", icon: MessageCircle },
    { id: "approvals", label: "Approvals", icon: ShieldCheck, badge: approvals },
    { id: "status", label: "Status", icon: Activity },
    { id: "settings", label: "Settings", icon: Settings },
  ];
  return (
    <nav className="mobile-tabbar" aria-label="Sections">
      <div className="mobile-tabbar-row grid grid-cols-4">
        {items.map((item) => {
          const active = item.id === tab;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => navigate(item.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "m-press relative flex flex-col items-center justify-center gap-0.5",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <span className="relative">
                <Icon className="size-[1.375rem]" strokeWidth={active ? 2.25 : 1.75} />
                {item.badge ? (
                  <span className="absolute -right-2.5 -top-1.5 min-w-[1.125rem] rounded-full bg-[var(--circle-consent)] px-1 text-center text-badge font-semibold leading-[1.125rem] text-[var(--circle-consent-fg)]">
                    {item.badge > 9 ? "9+" : item.badge}
                  </span>
                ) : null}
              </span>
              <span className="text-2xs font-medium">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** A slim strip under the header while the socket is down. Waits a beat to avoid flicker. */
export function ConnectionBanner() {
  const conn = useMobile((s) => s.conn);
  const [show, setShow] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  useEffect(() => {
    if (conn === "online") {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), 1200);
    return () => clearTimeout(t);
  }, [conn]);
  if (!show) return null;
  return (
    <div
      role="status"
      className="m-fade-in flex items-center justify-center gap-2 bg-[var(--m-surface-strong)] px-4 py-1.5 text-xs text-muted-foreground border-b border-[var(--m-hairline)]"
    >
      {online ? (
        <>
          <span className="m-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          Reconnecting to your gateway
        </>
      ) : (
        <>
          <WifiOff className="size-3.5" />
          You are offline. Messages will wait until you are back.
        </>
      )}
    </div>
  );
}
