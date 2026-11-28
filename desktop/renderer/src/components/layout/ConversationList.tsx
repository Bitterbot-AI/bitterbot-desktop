import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { toast } from "sonner";
import { openSession, startNewChat } from "../../lib/chat-nav";
import { describeError } from "../../lib/describe-error";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat-store";
import {
  groupByRecency,
  sessionTitle,
  useSessionsStore,
  type SessionEntry,
} from "../../stores/sessions-store";
import { useUIStore } from "../../stores/ui-store";
import { useConfirm } from "../ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/** Mirrors SESSION_LABEL_MAX_LENGTH on the gateway. */
const TITLE_MAX_LENGTH = 64;

function RenameField({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (next: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      aria-label="Conversation title"
      value={value}
      maxLength={TITLE_MAX_LENGTH}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value);
        if (e.key === "Escape") onDone(null);
      }}
      className="h-9 w-full rounded-md border border-control bg-raised px-3 text-sm text-ink outline-none focus-visible:border-focus"
    />
  );
}

function ConversationRow({
  session,
  active,
  onRename,
  onDelete,
}: {
  session: SessionEntry;
  active: boolean;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const title = sessionTitle(session);

  if (renaming) {
    return (
      <RenameField
        initial={session.label ?? session.derivedTitle ?? ""}
        onDone={(next) => {
          setRenaming(false);
          if (next !== null && next.trim() !== (session.label ?? "")) onRename(next);
        }}
      />
    );
  }

  return (
    <div
      className={cn(
        "group relative flex h-9 items-center rounded-md transition-colors",
        active ? "bg-selected" : "hover:bg-hover focus-within:bg-hover",
      )}
    >
      <button
        type="button"
        onClick={() => openSession(session.key)}
        title={title}
        aria-current={active ? "page" : undefined}
        className={cn(
          "h-full min-w-0 flex-1 truncate rounded-md pl-3 pr-9 text-left text-sm text-ink",
          active && "font-medium",
        )}
      >
        {title}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${title}`}
            className={cn(
              "absolute right-0.5 grid size-8 place-items-center rounded-md text-ink-secondary hover:text-ink",
              // Hidden until the row is hovered or focused; always present on
              // touch, where there is no hover.
              "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100",
            )}
          >
            <MoreHorizontal className="size-4" strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil className="size-4" strokeWidth={1.75} />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 className="size-4" strokeWidth={1.75} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Recent conversations, grouped Today / Previous 7 days / Older. */
export function ConversationList(): JSX.Element | null {
  const sessions = useSessionsStore((s) => s.sessions);
  const sessionKey = useChatStore((s) => s.sessionKey);
  const onChat = useUIStore((s) => s.activeTab === "chat");
  const [confirm, confirmElement] = useConfirm();

  // A clean profile shows no empty section.
  if (sessions.length === 0) return null;

  const rename = async (key: string, title: string) => {
    try {
      await useSessionsStore.getState().rename(key, title);
    } catch (err) {
      toast.error("Couldn't rename the conversation", { description: describeError(err) });
    }
  };

  const remove = async (session: SessionEntry) => {
    const title = sessionTitle(session);
    const ok = await confirm({
      title: "Delete chat?",
      description: `"${title}" will be deleted. This can't be undone.`,
      actionLabel: "Delete chat",
      destructive: true,
    });
    if (!ok) return;
    try {
      await useSessionsStore.getState().remove(session.key);
      // Deleting the open conversation leaves nothing to show; start fresh.
      if (session.key === useChatStore.getState().sessionKey) startNewChat();
    } catch (err) {
      toast.error("Couldn't delete the conversation", { description: describeError(err) });
    }
  };

  return (
    <div className="flex flex-col gap-5 px-3 pb-3">
      {groupByRecency(sessions).map((group) => (
        <section key={group.id} aria-label={group.label}>
          <h2 className="px-3 pb-1 text-xs text-ink-muted">{group.label}</h2>
          <div className="flex flex-col gap-0.5">
            {group.sessions.map((session) => (
              <ConversationRow
                key={session.key}
                session={session}
                active={onChat && session.key === sessionKey}
                onRename={(title) => void rename(session.key, title)}
                onDelete={() => void remove(session)}
              />
            ))}
          </div>
        </section>
      ))}
      {confirmElement}
    </div>
  );
}
