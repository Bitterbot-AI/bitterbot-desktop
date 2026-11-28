import { MessageSquare, Monitor, Moon, SquarePen, Sun } from "lucide-react";
import { useEffect } from "react";
import { useAvailableFeatures } from "../../hooks/useAvailableFeatures";
import { openSession, startNewChat } from "../../lib/chat-nav";
import { CONTROL_SECTIONS, visibleNavItems } from "../../nav-manifest";
import { sessionTitle, useSessionsStore } from "../../stores/sessions-store";
import { useUIStore, type TabId, type ThemePreference } from "../../stores/ui-store";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";

const SECTION_LABEL: Record<string, string> = Object.fromEntries(
  CONTROL_SECTIONS.map((s) => [s.id, s.label]),
);

/**
 * Plain matching: every word typed must appear in the item's text. cmdk's
 * default is a fuzzy subsequence score, which offers "Draft the release
 * notes" for "clone". Items are matched on their keywords, which hold only
 * what the person can read; `value` is just a unique id.
 */
export function matchesAllWords(_value: string, search: string, keywords?: string[]): number {
  const haystack = (keywords ?? []).join(" ").toLowerCase();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((word) => haystack.includes(word)) ? 1 : 0;
}

/**
 * Search and jump (PLAN-65). Finds a conversation by its title, goes to any
 * view this gateway offers, and runs a few commands. Matching conversation
 * content arrives with the transcript-search phase; until then this searches
 * titles only and says so.
 */
export function CommandPalette() {
  const open = useUIStore((s) => s.paletteOpen);
  const setOpen = useUIStore((s) => s.setPaletteOpen);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const setTheme = useUIStore((s) => s.setTheme);
  const sessions = useSessionsStore((s) => s.sessions);
  const features = useAvailableFeatures();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const ui = useUIStore.getState();
        ui.setPaletteOpen(!ui.paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  const go = (id: TabId) => run(() => setActiveTab(id));
  const theme = (preference: ThemePreference) => run(() => setTheme(preference));

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search"
      description="Find a conversation by title, go to a view, or run a command."
      // 560px wide, in the upper third of the window.
      contentClassName="top-[32%] sm:max-w-[560px]"
      filter={matchesAllWords}
    >
      <CommandInput placeholder="Search conversations and commands" />
      <CommandList>
        <CommandEmpty>
          Nothing matches. Search covers conversation titles, not their contents yet.
        </CommandEmpty>
        {sessions.length > 0 && (
          <CommandGroup heading="Conversations">
            {sessions.map((session) => (
              <CommandItem
                key={session.key}
                value={`session ${session.key}`}
                keywords={[sessionTitle(session)]}
                onSelect={() => run(() => openSession(session.key))}
              >
                <MessageSquare strokeWidth={1.75} />
                <span className="truncate">{sessionTitle(session)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Go to">
          {visibleNavItems(features).map((item) => (
            <CommandItem
              key={item.id}
              value={`go ${item.id}`}
              keywords={[
                item.label,
                ...(item.section ? [SECTION_LABEL[item.section], "control center"] : []),
              ]}
              onSelect={() => go(item.id)}
            >
              <item.icon strokeWidth={1.75} />
              <span>{item.label}</span>
              {item.section && (
                <span className="ml-auto text-xs text-ink-muted">
                  {SECTION_LABEL[item.section]}
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Commands">
          <CommandItem
            value="command new chat"
            keywords={["new chat conversation"]}
            onSelect={() => run(() => startNewChat())}
          >
            <SquarePen strokeWidth={1.75} />
            New chat
          </CommandItem>
          <CommandItem
            value="command theme system"
            keywords={["appearance theme follow system"]}
            onSelect={() => theme("system")}
          >
            <Monitor strokeWidth={1.75} />
            Appearance: follow system
          </CommandItem>
          <CommandItem
            value="command theme light"
            keywords={["appearance theme light"]}
            onSelect={() => theme("light")}
          >
            <Sun strokeWidth={1.75} />
            Appearance: light
          </CommandItem>
          <CommandItem
            value="command theme dark"
            keywords={["appearance theme dark"]}
            onSelect={() => theme("dark")}
          >
            <Moon strokeWidth={1.75} />
            Appearance: dark
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
