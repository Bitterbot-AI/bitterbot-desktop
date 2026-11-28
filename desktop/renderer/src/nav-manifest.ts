/**
 * ONE nav manifest as the single source of truth for which views exist and
 * where they live (PLAN-41 p0-13, regrouped by PLAN-65). `TabId` derives from
 * this list (plus "chat", which is entered through the conversation list), so
 * a view cannot exist without a nav decision.
 *
 * Placement (PLAN-65):
 *   - "sidebar": the few destinations about the person's own work. They sit
 *     in the sidebar above the conversation list.
 *   - "control": everything used to operate the agent. These open inside the
 *     Control Center, grouped by `section`.
 *
 * Debug, Instances, Projects and Sessions were deleted outright
 * (adjudicated D-H; restorable from git).
 */
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Brain,
  Lightbulb,
  Plug,
  Bot,
  BrainCircuit,
  Clock,
  Coins,
  Cpu,
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

export type NavPlace = "sidebar" | "control";

/** Control Center groups, in display order. */
export const CONTROL_SECTIONS = [
  { id: "agent", label: "Agent" },
  { id: "models", label: "Models & usage" },
  { id: "network", label: "Channels & network" },
  { id: "money", label: "Money" },
  { id: "safety", label: "Safety" },
  { id: "system", label: "System" },
] as const;

export type ControlSection = (typeof CONTROL_SECTIONS)[number]["id"];

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  place: NavPlace;
  /** Required for, and only for, place "control". */
  section?: ControlSection;
  /** Shown only when the connected gateway advertises this feature. */
  requireFeature?: string;
}

const NAV_MANIFEST_LITERAL = [
  // ── Sidebar: the person's own work ──
  { id: "memory", label: "Memory", icon: Brain, place: "sidebar" },
  { id: "cron", label: "Automations", icon: Clock, place: "sidebar" },
  { id: "workspace", label: "Files", icon: FolderOpen, place: "sidebar" },
  { id: "people", label: "Circles", icon: Users, place: "sidebar" },
  // ── Control Center ──
  { id: "agents", label: "Agents", icon: Bot, place: "control", section: "agent" },
  { id: "skills", label: "Skills", icon: Puzzle, place: "control", section: "agent" },
  { id: "connectors", label: "Connectors", icon: Plug, place: "control", section: "agent" },
  { id: "curiosity", label: "Curiosity", icon: Lightbulb, place: "control", section: "agent" },
  { id: "dreams", label: "Dreams", icon: BrainCircuit, place: "control", section: "agent" },
  { id: "models", label: "Models & Keys", icon: KeyRound, place: "control", section: "models" },
  // PLAN-50: cost is a daily-glance surface.
  { id: "usage", label: "Usage", icon: BarChart3, place: "control", section: "models" },
  { id: "channels", label: "Channels", icon: Radio, place: "control", section: "network" },
  { id: "nodes", label: "Nodes", icon: Server, place: "control", section: "network" },
  { id: "p2p", label: "P2P Network", icon: Globe, place: "control", section: "network" },
  { id: "compute", label: "Compute", icon: Cpu, place: "control", section: "network" },
  { id: "wallet", label: "Wallet", icon: Wallet, place: "control", section: "money" },
  { id: "spendGrants", label: "Spend Grants", icon: Coins, place: "control", section: "money" },
  { id: "guards", label: "Active Guards", icon: ShieldCheck, place: "control", section: "safety" },
  { id: "overview", label: "Overview", icon: Gauge, place: "control", section: "system" },
  { id: "config", label: "Settings", icon: Settings, place: "control", section: "system" },
  { id: "logs", label: "Logs", icon: ScrollText, place: "control", section: "system" },
  {
    id: "management",
    label: "Management",
    icon: Shield,
    place: "control",
    section: "system",
    requireFeature: "management",
  },
] as const satisfies readonly NavItem[];

/** Every routable view. "chat" is the default view, entered via sessions. */
export type TabId = "chat" | (typeof NAV_MANIFEST_LITERAL)[number]["id"];

/** Widened view so optional fields (requireFeature) are accessible. */
export const NAV_MANIFEST: readonly (NavItem & { id: TabId })[] = NAV_MANIFEST_LITERAL;

/** Where the Control Center opens the first time. */
export const DEFAULT_CONTROL_TAB: TabId = "overview";

export function navItem(id: TabId): (NavItem & { id: TabId }) | undefined {
  return NAV_MANIFEST.find((item) => item.id === id);
}

export function isControlTab(id: TabId): boolean {
  return navItem(id)?.place === "control";
}

/** Items the connected gateway can actually show. */
export function visibleNavItems(features: readonly string[]): (NavItem & { id: TabId })[] {
  return NAV_MANIFEST.filter(
    (item) => !item.requireFeature || features.includes(item.requireFeature),
  );
}
