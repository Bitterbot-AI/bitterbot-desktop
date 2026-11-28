import { PanelLeftClose } from "lucide-react";
import { useUIStore } from "../../stores/ui-store";
import { ConversationList } from "./ConversationList";
import { SidebarFooter } from "./SidebarFooter";
import { ControlCenterRow, SidebarPrimaryNav } from "./SidebarNav";

/**
 * The work sidebar (PLAN-65). Top to bottom: identity row, New chat and
 * Search, the fixed destinations, recent conversations, then Control Center
 * and the footer. Only the conversation list scrolls on a normal window; on a
 * short one the destinations scroll with it so the footer stays reachable.
 *
 * Operator views are not listed here. They live in the Control Center.
 */
export function Sidebar() {
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  return (
    <aside
      aria-label="Sidebar"
      className="flex h-full w-[260px] shrink-0 flex-col border-r border-line bg-sidebar"
      data-sidebar
    >
      <div className="flex h-14 shrink-0 items-center justify-between pl-4 pr-2">
        <div className="flex items-center gap-2">
          <img src="/Bitterbot_logo.svg" alt="" className="size-6" />
          <span className="text-base font-semibold tracking-tight">
            <span className="text-ink">Bitter</span>
            <span className="text-wordmark">Bot</span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
          title="Close sidebar"
          className="grid size-8 place-items-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
        >
          <PanelLeftClose className="size-[18px]" strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="shrink-0 pb-5 [@media(min-height:640px)]:sticky [@media(min-height:640px)]:top-0 [@media(min-height:640px)]:z-10 [@media(min-height:640px)]:bg-sidebar">
          <SidebarPrimaryNav />
        </div>
        <ConversationList />
      </div>

      <div className="shrink-0 py-2">
        <ControlCenterRow />
      </div>
      <SidebarFooter />
    </aside>
  );
}
