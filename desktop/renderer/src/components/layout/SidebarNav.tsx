import { Search, SlidersHorizontal, SquarePen } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAvailableFeatures } from "../../hooks/useAvailableFeatures";
import { startNewChat } from "../../lib/chat-nav";
import { isControlTab, visibleNavItems } from "../../nav-manifest";
import { circlesAttention, useCirclesStore } from "../../stores/circles-store";
import { repairsAttention, useRepairsStore } from "../../stores/repairs-store";
import { useUIStore } from "../../stores/ui-store";
import { approvalsTitle, AttentionBadge } from "../circles/AttentionBadge";
import { SidebarRow } from "./SidebarRow";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const SEARCH_SHORTCUT = isMac ? "⌘K" : "Ctrl K";

/** New chat, Search, and the fixed destinations about the person's own work. */
export function SidebarPrimaryNav() {
  const activeTab = useUIStore((s) => s.activeTab);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const features = useAvailableFeatures();
  // Approvals (amber) outrank unread (red). useShallow: the circles array is
  // a new reference every poll; re-render only when the two counts change.
  const attention = useCirclesStore(useShallow((s) => circlesAttention(s.circles)));

  const items = visibleNavItems(features).filter((item) => item.place === "sidebar");

  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 px-3">
      <SidebarRow icon={SquarePen} label="New chat" onClick={() => startNewChat()} />
      <SidebarRow
        icon={Search}
        label="Search"
        onClick={() => setPaletteOpen(true)}
        trailing={<kbd className="text-xs text-ink-muted">{SEARCH_SHORTCUT}</kbd>}
      />
      <div className="h-2" />
      {items.map((item) => (
        <SidebarRow
          key={item.id}
          icon={item.icon}
          label={item.label}
          active={activeTab === item.id}
          onClick={() => setActiveTab(item.id)}
          trailing={
            item.id === "people" ? (
              attention.approvals > 0 ? (
                <AttentionBadge
                  count={attention.approvals}
                  tone="consent"
                  title={approvalsTitle(attention.approvals)}
                />
              ) : (
                <AttentionBadge
                  count={attention.unread}
                  tone="unread"
                  title={`${attention.unread} unread`}
                />
              )
            ) : undefined
          }
        />
      ))}
    </nav>
  );
}

/** One labelled row into the Control Center, returning to its last view. */
export function ControlCenterRow() {
  const activeTab = useUIStore((s) => s.activeTab);
  const controlTab = useUIStore((s) => s.controlTab);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  // Doctor findings that need attention surface here, since Overview lives
  // inside the Control Center.
  const repairs = useRepairsStore((s) => repairsAttention(s.findings));

  return (
    <div className="px-3">
      <SidebarRow
        icon={SlidersHorizontal}
        label="Control Center"
        active={isControlTab(activeTab)}
        onClick={() => setActiveTab(controlTab)}
        trailing={
          <AttentionBadge
            count={repairs}
            tone="consent"
            title={`${repairs} doctor finding(s) need attention`}
          />
        }
      />
    </div>
  );
}
