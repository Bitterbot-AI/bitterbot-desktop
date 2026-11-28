import { ChevronsUpDown, ExternalLink } from "lucide-react";
import { productName } from "../../lib/runtime";
import { cn } from "../../lib/utils";
import { useGatewayStore, type ConnectionStatus } from "../../stores/gateway-store";
import { useUIStore, type ThemePreference } from "../../stores/ui-store";
import { BitterBotAvatar } from "../chat/BitterBotAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

// Injected at build time from the root package.json (vite define, D-A).
const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? "dev";

/** The connection, in words. It describes the connection only, never the model. */
export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connected: "Gateway connected",
  connecting: "Reconnecting…",
  disconnected: "Disconnected",
};

const CONNECTION_DOT: Record<ConnectionStatus, string> = {
  connected: "bg-success",
  connecting: "bg-warning",
  disconnected: "bg-danger",
};

const HELP_LINKS = [
  {
    label: "Help & docs",
    href: "https://github.com/Bitterbot-AI/bitterbot-desktop/tree/main/docs",
  },
  { label: "About Bitterbot", href: "https://about.bitterbot.ai" },
  { label: "Bitterbot on X", href: "https://x.com/Bitterbot_AI" },
  { label: "Bitterbot on LinkedIn", href: "https://www.linkedin.com/company/106800101" },
  { label: "Email the team", href: "mailto:team@bitterbot.net" },
] as const;

const APPEARANCE: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Identity and connection, with Appearance, Help and version behind one menu. */
export function SidebarFooter() {
  const status = useGatewayStore((s) => s.status);
  const error = useGatewayStore((s) => s.error);
  const themePreference = useUIStore((s) => s.themePreference);
  const setTheme = useUIStore((s) => s.setTheme);

  return (
    <div className="border-t border-line p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Appearance, help and version"
            className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover data-[state=open]:bg-hover"
          >
            <BitterBotAvatar size={24} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{productName()}</span>
              <span
                className="flex items-center gap-1.5 text-xs text-ink-muted"
                title={error ?? undefined}
                role="status"
              >
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", CONNECTION_DOT[status])}
                />
                <span className="truncate">{CONNECTION_LABEL[status]}</span>
              </span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-ink-muted" strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-60">
          <DropdownMenuLabel className="text-xs font-normal text-ink-muted">
            Appearance
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={themePreference}
            onValueChange={(value) => setTheme(value as ThemePreference)}
          >
            {APPEARANCE.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          {HELP_LINKS.map((link) => (
            <DropdownMenuItem key={link.href} asChild>
              <a
                href={link.href}
                target={link.href.startsWith("mailto:") ? undefined : "_blank"}
                rel="noopener noreferrer"
              >
                <span className="flex-1">{link.label}</span>
                <ExternalLink className="size-3.5" strokeWidth={1.75} />
              </a>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-ink-muted">
            {productName()} v{APP_VERSION}
          </DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
