import { PanelLeftOpen, PanelRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat-store";
import { sessionTitle, useSessionsStore } from "../../stores/sessions-store";
import { useUIStore } from "../../stores/ui-store";
import { UsageStatusStrip } from "../usage/UsageStatusStrip";

const ICON_BUTTON =
  "grid size-8 shrink-0 place-items-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink";

/**
 * The 56px bar above a conversation: its title on the left (click to rename),
 * usage and the Computer pane toggle on the right. With the sidebar closed it
 * also carries the way back.
 */
export function ChatHeader() {
  const sessionKey = useChatStore((s) => s.sessionKey);
  const session = useSessionsStore((s) => s.sessions.find((e) => e.key === sessionKey));
  const rename = useSessionsStore((s) => s.rename);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const toolPanelOpen = useUIStore((s) => s.toolPanelOpen);
  const toggleToolPanel = useUIStore((s) => s.toggleToolPanel);
  const [draft, setDraft] = useState<string | null>(null);

  const title = session ? sessionTitle(session) : "New chat";

  const save = () => {
    const next = draft?.trim() ?? "";
    setDraft(null);
    if (!session || next === title) return;
    // An empty name hands the title back to the derived one.
    void rename(session.key, next).catch(() => {
      // The gateway store already reports the failure.
    });
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-5">
      {!sidebarOpen && (
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open sidebar"
          title="Open sidebar"
          className={ICON_BUTTON}
        >
          <PanelLeftOpen className="size-[18px]" strokeWidth={1.75} />
        </button>
      )}

      <div className="min-w-0 flex-1">
        {draft !== null ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setDraft(null);
            }}
            autoFocus
            aria-label="Conversation name"
            className="h-8 w-full max-w-md rounded-md border border-control bg-canvas px-2 text-base font-semibold text-ink focus:border-focus focus:outline-none"
          />
        ) : session ? (
          <button
            type="button"
            onClick={() => setDraft(title)}
            title="Rename"
            className="-ml-2 block max-w-full truncate rounded-md px-2 py-1 text-left text-base font-semibold text-ink transition-colors hover:bg-hover"
          >
            {title}
          </button>
        ) : (
          <h1 className="truncate text-base font-semibold text-ink">{title}</h1>
        )}
      </div>

      <UsageStatusStrip />
      <button
        type="button"
        onClick={toggleToolPanel}
        aria-pressed={toolPanelOpen}
        title={toolPanelOpen ? "Close Computer" : "Open Computer"}
        className={cn(
          "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm text-ink-secondary transition-colors hover:bg-hover hover:text-ink",
          toolPanelOpen && "bg-selected text-ink",
        )}
      >
        <PanelRight className="size-[18px]" strokeWidth={1.75} />
        <span className="hidden lg:inline">Computer</span>
        <span className="sr-only lg:hidden">Computer</span>
      </button>
    </header>
  );
}
