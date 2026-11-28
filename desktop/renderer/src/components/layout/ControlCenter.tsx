import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useAvailableFeatures } from "../../hooks/useAvailableFeatures";
import { cn } from "../../lib/utils";
import { CONTROL_SECTIONS, navItem, visibleNavItems } from "../../nav-manifest";
import { useUIStore, type TabId } from "../../stores/ui-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * The Control Center frame (PLAN-65): everything used to operate the agent,
 * grouped into six sections. The active view renders unchanged inside it.
 * Wide windows get a 200px group column; narrow ones a current-section
 * button that opens the same list as a menu.
 */
export function ControlCenter({ children }: { children: ReactNode }) {
  const activeTab = useUIStore((s) => s.activeTab);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const features = useAvailableFeatures();

  const items = visibleNavItems(features).filter((item) => item.place === "control");
  const sections = CONTROL_SECTIONS.map((section) => ({
    ...section,
    items: items.filter((item) => item.section === section.id),
  })).filter((section) => section.items.length > 0);
  const current = navItem(activeTab);

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="Control Center"
        className="hidden w-[200px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line px-2 py-4 md:flex"
      >
        <h1 className="px-3 text-base font-semibold text-ink">Control Center</h1>
        {sections.map((section) => (
          <div key={section.id}>
            <h2 className="px-3 pb-1 text-xs text-ink-muted">{section.label}</h2>
            <div className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <ControlNavButton
                  key={item.id}
                  id={item.id}
                  label={item.label}
                  active={item.id === activeTab}
                  onSelect={setActiveTab}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-line px-4 py-2 md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-9 items-center gap-2 rounded-md border border-control px-3 text-sm text-ink"
              >
                <span className="text-ink-muted">Control Center</span>
                <span className="font-medium">{current?.label}</span>
                <ChevronDown className="size-4 text-ink-secondary" strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[70vh] w-56 overflow-y-auto">
              {sections.map((section) => (
                <div key={section.id}>
                  <DropdownMenuLabel className="text-xs font-normal text-ink-muted">
                    {section.label}
                  </DropdownMenuLabel>
                  {section.items.map((item) => (
                    <DropdownMenuItem key={item.id} onSelect={() => setActiveTab(item.id)}>
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

function ControlNavButton({
  id,
  label,
  active,
  onSelect,
}: {
  id: TabId;
  label: string;
  active: boolean;
  onSelect: (id: TabId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center rounded-md px-3 text-left text-sm text-ink transition-colors",
        active ? "bg-selected font-medium" : "hover:bg-hover",
      )}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}
