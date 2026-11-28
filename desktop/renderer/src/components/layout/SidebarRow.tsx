import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** The one sidebar row: 36px, 8px radius, neutral hover and selected fills. */
export function SidebarRow({
  icon: Icon,
  label,
  active = false,
  onClick,
  trailing,
  title,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
  trailing?: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-ink transition-colors",
        active ? "bg-selected font-medium" : "hover:bg-hover",
      )}
    >
      <Icon
        className={cn("size-[18px] shrink-0", active ? "text-brand" : "text-ink-secondary")}
        strokeWidth={1.75}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}
