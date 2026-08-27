/**
 * PLAN-41 Phase 2 (p0-13): ONE nav manifest as the single source of truth
 * for which views exist and where they live. `TabId` derives from this list
 * (plus "chat", which is entered through the session list, not a nav row),
 * so a view cannot exist without a nav decision and the audit's
 * "8 unreachable compiled views" class of drift cannot recur.
 *
 * Groups: "main" is the SHIP set — what a fresh install needs. "advanced"
 * holds the power-user / experimental surfaces behind a collapsible header.
 * Debug, Instances, Projects and Sessions were deleted outright
 * (adjudicated D-H; restorable from git).
 */
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bot,
  BrainCircuit,
  Clock,
  FolderOpen,
  Gauge,
  Globe,
  KeyRound,
  Puzzle,
  Radio,
  ScrollText,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";

export type NavGroup = "main" | "advanced";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Shown only when the connected gateway advertises this feature. */
  requireFeature?: string;
}

const NAV_MANIFEST_LITERAL = [
  // ── SHIP set ──
  { id: "overview", label: "Overview", icon: Gauge, group: "main" },
  { id: "channels", label: "Channels", icon: Radio, group: "main" },
  { id: "agents", label: "Agents", icon: Bot, group: "main" },
  { id: "skills", label: "Skills", icon: Puzzle, group: "main" },
  { id: "cron", label: "Cron", icon: Clock, group: "main" },
  { id: "models", label: "Models & Keys", icon: KeyRound, group: "main" },
  { id: "config", label: "Settings", icon: Settings, group: "main" },
  // ── Advanced ──
  { id: "people", label: "Circles", icon: Users, group: "advanced" },
  { id: "p2p", label: "P2P Network", icon: Globe, group: "advanced" },
  { id: "guards", label: "Active Guards", icon: ShieldCheck, group: "advanced" },
  { id: "dreams", label: "Dreams", icon: BrainCircuit, group: "advanced" },
  { id: "wallet", label: "Wallet", icon: Wallet, group: "advanced" },
  { id: "workspace", label: "Workspace", icon: FolderOpen, group: "advanced" },
  { id: "nodes", label: "Nodes", icon: Server, group: "advanced" },
  { id: "usage", label: "Usage", icon: BarChart3, group: "advanced" },
  { id: "logs", label: "Logs", icon: ScrollText, group: "advanced" },
  {
    id: "management",
    label: "Management",
    icon: Shield,
    group: "advanced",
    requireFeature: "management",
  },
] as const satisfies readonly NavItem[];

/** Every routable view. "chat" is the default view, entered via sessions. */
export type TabId = "chat" | (typeof NAV_MANIFEST_LITERAL)[number]["id"];

/** Widened view so optional fields (requireFeature) are accessible. */
export const NAV_MANIFEST: readonly (NavItem & { id: TabId })[] = NAV_MANIFEST_LITERAL;
