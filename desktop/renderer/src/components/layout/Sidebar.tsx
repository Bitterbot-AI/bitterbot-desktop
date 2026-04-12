import type { LucideIcon } from "lucide-react";
import {
  Radio,
  Bot,
  Puzzle,
  Globe,
  Wallet,
  Settings,
  MessageSquare,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  BrainCircuit,
  Shield,
  X,
  ChevronDown,
  ChevronUp,
  Trash2,
  Check,
  Sun,
  Moon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { useUIStore, type TabId } from "../../stores/ui-store";
import { WalletSidebarPanel } from "../wallet/WalletSidebarPanel";

interface SidebarSession {
  key: string;
  label?: string;
  derivedTitle?: string;
  updatedAt?: number | null;
}

interface NavItem {
  id: TabId;
  label: string;
  icon: LucideIcon;
  group: "control" | "agent" | "settings";
  /** If set, the item is only shown when this feature key is present. */
  requireFeature?: string;
}

const NAV_ITEMS: NavItem[] = [
  // Control
  { id: "channels", label: "Channels", icon: Radio, group: "control" },
  { id: "p2p", label: "P2P Network", icon: Globe, group: "control" },
  {
    id: "management",
    label: "Management",
    icon: Shield,
    group: "control",
    requireFeature: "management",
  },
  // Agent
  { id: "agents", label: "Agents", icon: Bot, group: "agent" },
  { id: "skills", label: "Skills", icon: Puzzle, group: "agent" },
  { id: "dreams", label: "Dreams (beta)", icon: BrainCircuit, group: "agent" },
  // Settings
  { id: "config", label: "Config", icon: Settings, group: "settings" },
];

const GROUP_LABELS: Record<string, string> = {
  control: "CONTROL PANEL",
  agent: "AGENT",
  settings: "SETTINGS",
};

const GROUPS = ["control", "agent", "settings"] as const;

// Social link SVGs from webapp
function AboutIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

interface SocialLinkProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  isEmail?: boolean;
}

function SocialLink({ href, icon, label, collapsed, isEmail }: SocialLinkProps) {
  return (
    <a
      href={href}
      target={isEmail ? undefined : "_blank"}
      rel={isEmail ? undefined : "noopener noreferrer"}
      className={cn(
        "flex items-center rounded-lg hover:bg-[var(--sidebar-hover)] transition-colors text-[var(--sidebar-text-muted)] hover:text-purple-400",
        collapsed ? "w-8 h-8 justify-center" : "gap-3 px-2 py-2",
      )}
      title={label}
    >
      {icon}
      {!collapsed && <span className="text-sm">{label}</span>}
    </a>
  );
}

export function Sidebar() {
  const activeTab = useUIStore((s) => s.activeTab);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const sessionKey = useChatStore((s) => s.sessionKey);
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);

  // Probe whether this node is a management node by calling management.health.
  // Only runs once on connect; caches the result.
  const [isManagementNode, setIsManagementNode] = useState(false);
  useEffect(() => {
    if (gwStatus !== "connected") {
      setIsManagementNode(false);
      return;
    }
    let cancelled = false;
    request("management.health")
      .then((res) => {
        if (!cancelled && res && typeof res === "object") {
          setIsManagementNode(true);
        }
      })
      .catch(() => {
        if (!cancelled) setIsManagementNode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gwStatus, request]);

  const [sessions, setSessions] = useState<SidebarSession[]>([]);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const refreshTimer = useRef<ReturnType<typeof setInterval>>();
  const MAX_VISIBLE_SESSIONS = 4;

  const fetchSessions = useCallback(async () => {
    if (gwStatus !== "connected") return;
    try {
      const res = (await request("sessions.list", {
        includeDerivedTitles: true,
        limit: 50,
      })) as { sessions?: SidebarSession[] };
      if (res?.sessions) {
        setSessions(res.sessions);
      }
    } catch {
      // ignore — sidebar sessions are best-effort
    }
  }, [gwStatus, request]);

  useEffect(() => {
    fetchSessions();
    clearInterval(refreshTimer.current);
    if (gwStatus === "connected") {
      refreshTimer.current = setInterval(fetchSessions, 30_000);
    }
    return () => clearInterval(refreshTimer.current);
  }, [gwStatus, fetchSessions]);

  // Also refresh after creating a new conversation (when sessionKey changes)
  useEffect(() => {
    const timer = setTimeout(fetchSessions, 1000);
    return () => clearTimeout(timer);
  }, [sessionKey, fetchSessions]);

  const switchToSession = useCallback(
    (key: string) => {
      useChatStore.getState().clearMessages();
      useChatStore.getState().setSessionKey(key);
      setActiveTab("chat");
    },
    [setActiveTab],
  );

  const isCollapsed = sidebarCollapsed;

  return (
    <aside
      className={cn(
        "flex-shrink-0 h-full flex flex-col sidebar-bg transition-all duration-200",
        isCollapsed ? "w-12" : "w-64",
      )}
      data-sidebar
    >
      {/* Header */}
      {isCollapsed ? (
        <div className="flex flex-col items-center border-b border-[var(--sidebar-border-subtle)] drag-region py-2 gap-1">
          <img src="/Bitterbot_logo.svg" alt="BitterBot" className="w-6 h-6" />
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="flex items-center justify-center w-8 h-8 rounded-md hover:bg-[var(--sidebar-hover)] transition-colors text-[var(--sidebar-text-muted)] hover:text-[var(--sidebar-text-primary)] no-drag"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="h-14 flex items-center justify-between px-4 border-b border-[var(--sidebar-border-subtle)] drag-region">
          <div className="flex items-center gap-2">
            <img src="/Bitterbot_logo.svg" alt="BitterBot" className="w-7 h-7" />
            <span className="text-lg font-bold tracking-tight">
              <span className="text-foreground">Bitter</span>
              <span className="text-[#a855f7]">Bot</span>
            </span>
          </div>
          <button
            onClick={() => setSidebarCollapsed(true)}
            className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-[var(--sidebar-hover)] transition-colors text-[var(--sidebar-text-muted)] hover:text-[var(--sidebar-text-primary)] no-drag"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* New Conversation Button */}
      <div
        className={cn(
          "border-b border-[var(--sidebar-border-subtle)]",
          isCollapsed ? "p-2" : "p-4",
        )}
      >
        <button
          onClick={() => {
            const key = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            useChatStore.getState().clearMessages();
            useChatStore.getState().setSessionKey(key);
            setActiveTab("chat");
          }}
          className={cn(
            "flex items-center rounded-lg transition-colors",
            "bg-[rgba(139,92,246,0.1)] hover:bg-[rgba(139,92,246,0.15)] text-purple-400",
            isCollapsed ? "w-8 h-8 justify-center" : "w-full gap-2 px-3 py-2 text-sm font-medium",
          )}
        >
          <Plus className="w-4 h-4" />
          {!isCollapsed && <span>New Conversation</span>}
        </button>
      </div>

      {/* Wallet Panel */}
      <WalletSidebarPanel collapsed={isCollapsed} />

      {/* Chat History Section */}
      <div
        className={cn(
          "border-b border-[var(--sidebar-border-subtle)] flex flex-col",
          isCollapsed ? "p-2" : "px-4 py-3",
        )}
      >
        {!isCollapsed && (
          <div className="flex items-center justify-between mb-1">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-[#00D4E6]">
              CONVERSATIONS
            </div>
            {selectedSessions.size > 0 ? (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground">
                  {selectedSessions.size} selected
                </span>
                <button
                  onClick={async () => {
                    for (const key of selectedSessions) {
                      try {
                        await request("sessions.delete", { key });
                      } catch {}
                    }
                    setSelectedSessions(new Set());
                    fetchSessions();
                  }}
                  className="p-1 rounded text-red-400 hover:bg-red-500/10 transition-colors"
                  title="Delete selected"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
                <button
                  onClick={() => setSelectedSessions(new Set())}
                  className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                  title="Cancel selection"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              sessions.length > 1 && (
                <button
                  onClick={() => {
                    // Enter selection mode with nothing selected
                    setSelectedSessions(new Set(["__selection_mode__"]));
                  }}
                  className="px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground rounded hover:bg-muted/30 transition-colors"
                >
                  Select
                </button>
              )
            )}
          </div>
        )}
        <div
          className={cn(
            "space-y-0.5 overflow-y-auto scrollbar-none",
            isCollapsed ? "max-h-32" : "max-h-[280px]",
          )}
        >
          {sessions.length === 0 ? (
            <button
              onClick={() => setActiveTab("chat")}
              className={cn(
                "flex items-center rounded-md transition-all",
                "hover:bg-[rgba(139,92,246,0.05)] hover:text-[#d8b4fe]",
                activeTab === "chat"
                  ? "bg-[rgba(139,92,246,0.1)] text-[#c084fc] font-medium"
                  : "text-[var(--sidebar-text-secondary)]",
                isCollapsed ? "w-8 h-8 justify-center" : "w-full gap-2 px-3 py-1.5 text-sm",
              )}
            >
              <MessageSquare className="w-4 h-4 flex-shrink-0" />
              {!isCollapsed && <span className="truncate">Current Session</span>}
            </button>
          ) : (
            <>
              {(showAllSessions ? sessions : sessions.slice(0, MAX_VISIBLE_SESSIONS)).map((s) => {
                const isActive = activeTab === "chat" && sessionKey === s.key;
                const title = s.derivedTitle || s.label || s.key;
                const isSelected = selectedSessions.has(s.key);
                const inSelectionMode = selectedSessions.size > 0;
                return (
                  <div
                    key={s.key}
                    className={cn(
                      "flex items-center rounded-md transition-all group",
                      "hover:bg-[rgba(139,92,246,0.05)] hover:text-[#d8b4fe]",
                      isActive
                        ? "bg-[rgba(139,92,246,0.1)] text-[#c084fc] font-medium"
                        : "text-[var(--sidebar-text-secondary)]",
                      isCollapsed ? "w-8 h-8 justify-center" : "w-full px-3 py-1.5 text-sm",
                    )}
                  >
                    {/* Selection checkbox (visible on hover or in selection mode) */}
                    {!isCollapsed && inSelectionMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = new Set(selectedSessions);
                          next.delete("__selection_mode__");
                          if (isSelected) next.delete(s.key);
                          else next.add(s.key);
                          if (next.size === 0) next.add("__selection_mode__");
                          setSelectedSessions(next);
                        }}
                        className={cn(
                          "w-4 h-4 rounded border flex-shrink-0 mr-2 flex items-center justify-center transition-colors",
                          isSelected
                            ? "bg-purple-500 border-purple-500 text-white"
                            : "border-muted-foreground/40 hover:border-purple-400",
                        )}
                      >
                        {isSelected && <Check className="w-3 h-3" />}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (inSelectionMode) {
                          const next = new Set(selectedSessions);
                          next.delete("__selection_mode__");
                          if (isSelected) next.delete(s.key);
                          else next.add(s.key);
                          if (next.size === 0) next.add("__selection_mode__");
                          setSelectedSessions(next);
                        } else {
                          switchToSession(s.key);
                        }
                      }}
                      title={isCollapsed ? title : undefined}
                      className="flex items-center gap-2 flex-1 min-w-0"
                    >
                      <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
                      {!isCollapsed && <span className="flex-1 truncate text-left">{title}</span>}
                    </button>
                    {/* Delete button on hover (not in selection mode) */}
                    {!isCollapsed && !inSelectionMode && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await request("sessions.delete", { key: s.key });
                            fetchSessions();
                          } catch {}
                        }}
                        className="p-0.5 rounded text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-red-400 transition-colors flex-shrink-0"
                        title="Delete conversation"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}
              {/* Show More / Show Less toggle */}
              {!isCollapsed && sessions.length > MAX_VISIBLE_SESSIONS && (
                <button
                  onClick={() => setShowAllSessions(!showAllSessions)}
                  className="flex items-center gap-1 w-full px-3 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showAllSessions ? (
                    <>
                      <ChevronUp className="w-3 h-3" />
                      <span>Show Less</span>
                    </>
                  ) : (
                    <>
                      <ChevronDown className="w-3 h-3" />
                      <span>Show {sessions.length - MAX_VISIBLE_SESSIONS} More</span>
                    </>
                  )}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-4 scrollbar-none">
        {GROUPS.map((group) => {
          const items = NAV_ITEMS.filter(
            (item) =>
              item.group === group &&
              (!item.requireFeature || (item.requireFeature === "management" && isManagementNode)),
          );
          return (
            <div key={group}>
              {!isCollapsed && (
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-[#00D4E6]">
                  {GROUP_LABELS[group]}
                </div>
              )}
              <div className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id)}
                      data-active={activeTab === item.id ? "true" : undefined}
                      title={isCollapsed ? item.label : undefined}
                      className={cn(
                        "flex items-center rounded-md text-sm transition-all",
                        "hover:bg-[rgba(139,92,246,0.05)] hover:text-[#d8b4fe]",
                        activeTab === item.id
                          ? "bg-[rgba(139,92,246,0.1)] text-[#c084fc] font-medium"
                          : "text-[var(--sidebar-text-secondary)]",
                        isCollapsed ? "w-8 h-8 justify-center mx-auto" : "w-full gap-2 px-3 py-1.5",
                      )}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      {!isCollapsed && <span>{item.label}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Social Links */}
      <div
        className={cn(
          "border-t border-[var(--sidebar-border-subtle)] py-3",
          isCollapsed ? "px-2" : "px-4",
        )}
      >
        {isCollapsed ? (
          <div className="flex flex-col items-center gap-2">
            <SocialLink
              href="https://about.bitterbot.ai"
              icon={<AboutIcon />}
              label="About BitterBot"
              collapsed
            />
            <SocialLink
              href="https://x.com/Bitterbot_AI"
              icon={<XIcon />}
              label="Follow us on X"
              collapsed
            />
            <SocialLink
              href="https://www.linkedin.com/company/106800101"
              icon={<LinkedInIcon />}
              label="Connect on LinkedIn"
              collapsed
            />
            <SocialLink
              href="mailto:team@bitterbot.net"
              icon={<EmailIcon />}
              label="Email us"
              collapsed
              isEmail
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <SocialLink
              href="https://about.bitterbot.ai"
              icon={<AboutIcon />}
              label="About BitterBot"
              collapsed={false}
            />
            <SocialLink
              href="https://x.com/Bitterbot_AI"
              icon={<XIcon />}
              label="Follow us on X"
              collapsed={false}
            />
            <SocialLink
              href="https://www.linkedin.com/company/106800101"
              icon={<LinkedInIcon />}
              label="Connect on LinkedIn"
              collapsed={false}
            />
            <SocialLink
              href="mailto:team@bitterbot.net"
              icon={<EmailIcon />}
              label="Email us"
              collapsed={false}
              isEmail
            />
          </div>
        )}
      </div>

      {/* Theme Toggle + Version Footer */}
      <div
        className={cn(
          "border-t border-[var(--sidebar-border-subtle)] text-xs text-[var(--sidebar-text-muted)]",
          isCollapsed
            ? "p-2 flex flex-col items-center gap-2"
            : "p-3 flex items-center justify-between",
        )}
      >
        {isCollapsed ? (
          <>
            <button
              onClick={toggleTheme}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text-muted)] hover:text-[var(--sidebar-text-primary)] transition-colors"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? (
                <Sun className="w-3.5 h-3.5" />
              ) : (
                <Moon className="w-3.5 h-3.5" />
              )}
            </button>
            <span title="Bitterbot Desktop v2026.2.15">v2</span>
          </>
        ) : (
          <>
            <span>Bitterbot Desktop v2026.2.15</span>
            <button
              onClick={toggleTheme}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text-muted)] hover:text-[var(--sidebar-text-primary)] transition-colors"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? (
                <Sun className="w-3.5 h-3.5" />
              ) : (
                <Moon className="w-3.5 h-3.5" />
              )}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
