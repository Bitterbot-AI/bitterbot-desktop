import { Check, MessageSquarePlus, PlusSquare, Share, X } from "lucide-react";
import { Drawer, DrawerContent, DrawerTitle } from "../../components/ui/drawer";
import { cn } from "../../lib/utils";
import { readPersisted } from "../persist";
import { newPhoneSessionKey } from "../session-key";
import { useMobile } from "../store";
import { sessionTitle } from "./Chrome";

function ago(ts: number | null): string {
  if (!ts) return "";
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

export function SessionSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const sessions = useMobile((s) => s.sessions);
  const current = useMobile((s) => s.sessionKey);
  const unread = useMobile((s) => s.unread);
  const setSession = useMobile((s) => s.setSession);
  const pick = (key: string) => {
    setSession(key);
    onOpenChange(false);
  };
  const chats = sessions.filter((s) => !s.key.includes(":cron:") && !s.key.includes(":subagent:"));
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="mobile-app max-h-[80dvh] border-[var(--m-hairline)] bg-background pb-[var(--m-safe-bottom)]">
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <DrawerTitle className="text-base">Conversations</DrawerTitle>
          <button
            type="button"
            onClick={() => pick(newPhoneSessionKey(readPersisted().deviceId) ?? "main")}
            className="m-press m-touch -mr-2 flex items-center gap-1.5 px-2 text-sm font-semibold text-primary"
          >
            <MessageSquarePlus className="size-4" />
            New
          </button>
        </div>
        <div className="overflow-y-auto px-2 pb-3">
          {chats.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No other conversations yet.
            </p>
          ) : (
            chats.map((row) => {
              const active = row.key === current || row.key.endsWith(`:${current}`);
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => pick(row.key)}
                  className={cn(
                    "m-press flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left",
                    active && "bg-primary/10",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-semibold">
                      {unread[row.key] ? (
                        <span className="size-2 shrink-0 rounded-full bg-primary" />
                      ) : null}
                      <span className="truncate">{sessionTitle(row.key, [row])}</span>
                    </p>
                    {row.lastMessagePreview ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {row.lastMessagePreview}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {ago(row.updatedAt)}
                  </span>
                  {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
                </button>
              );
            })
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export function InstallSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const close = () => onOpenChange(false);
  return (
    <Drawer open={open} onOpenChange={(v) => (v ? onOpenChange(v) : close())}>
      <DrawerContent className="mobile-app border-[var(--m-hairline)] bg-background pb-[calc(var(--m-safe-bottom)+1rem)]">
        <div className="flex items-start justify-between px-5 pt-3">
          <DrawerTitle className="text-lg">Put Bitterbot on your Home Screen</DrawerTitle>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="m-press m-touch -mr-3 -mt-2 flex items-center justify-center text-muted-foreground"
          >
            <X className="size-5" />
          </button>
        </div>
        <p className="px-5 pt-1 text-sm leading-relaxed text-muted-foreground">
          It opens full screen like an app, and it is the only way iPhone allows notifications for
          web apps. iPhone keeps the Home Screen app separate from Safari, so it pairs once on its
          own.
        </p>
        <ol className="flex flex-col gap-3 px-5 pt-5">
          {[
            { icon: Share, text: "Tap the Share button in Safari's toolbar." },
            { icon: PlusSquare, text: "Scroll down and choose Add to Home Screen." },
            {
              icon: Check,
              text: "Open Bitterbot from the new icon and pair it from your computer, then unpair this Safari copy here in Settings.",
            },
          ].map((step, i) => (
            <li key={i} className="m-card flex items-center gap-3 p-3.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <step.icon className="size-[1.125rem]" />
              </span>
              <span className="text-sm leading-snug">{step.text}</span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={close}
          className="m-press m-touch mx-5 mt-5 rounded-xl bg-primary text-sm font-semibold text-primary-foreground"
        >
          Got it
        </button>
      </DrawerContent>
    </Drawer>
  );
}
