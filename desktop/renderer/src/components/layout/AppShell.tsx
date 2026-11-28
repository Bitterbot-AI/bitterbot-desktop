import { PanelLeftOpen } from "lucide-react";
import { useSessionsSync } from "../../hooks/useSessionsSync";
import { isControlTab } from "../../nav-manifest";
import { useUIStore, type TabId } from "../../stores/ui-store";
import { AgentsView } from "../agents/AgentsView";
import { ChannelsView } from "../channels/ChannelsView";
import { ChatView } from "../chat/ChatView";
import { ToolCallPanel } from "../chat/ToolCallPanel";
import { CirclesGlobalSync } from "../circles/CirclesGlobalSync";
import { CirclesView } from "../circles/CirclesView";
import { ComputeView } from "../compute/ComputeView";
import { ConfigView } from "../config/ConfigView";
import { ConnectorsView } from "../connectors/ConnectorsView";
import { CronView } from "../cron/CronView";
import { CuriosityView } from "../curiosity/CuriosityView";
import { DreamsView } from "../dreams/DreamsView";
import { ActiveGuardsView } from "../guards/ActiveGuardsView";
import { LogsView } from "../logs/LogsView";
import { ManagementView } from "../management/ManagementView";
import { MemoryView } from "../memory/MemoryView";
import { ModelsView } from "../models/ModelsView";
import { NodesView } from "../nodes/NodesView";
import { OwnerNoticeToasts } from "../notices/OwnerNoticeToasts";
import { OverviewView } from "../overview/OverviewView";
import { P2pDashboard } from "../p2p/P2pDashboard";
import { SkillsView } from "../skills/SkillsView";
import { SpendGrantsView } from "../spend-grants/SpendGrantsView";
import { UsageBudgetToasts } from "../usage/UsageBudgetToasts";
import { UsageView } from "../usage/UsageView";
import { WalletView } from "../wallet/WalletView";
import { WorkspaceView } from "../workspace/WorkspaceView";
import { CommandPalette } from "./CommandPalette";
import { ControlCenter } from "./ControlCenter";
import { Sidebar } from "./Sidebar";
import { StaleBundleBanner } from "./StaleBundleBanner";
import { UpdateBanner } from "./UpdateBanner";

const VIEW_MAP: Record<TabId, () => JSX.Element> = {
  chat: () => <ChatView />,
  overview: () => <OverviewView />,
  channels: () => <ChannelsView />,
  usage: () => <UsageView />,
  cron: () => <CronView />,
  connectors: () => <ConnectorsView />,
  memory: () => <MemoryView />,
  curiosity: () => <CuriosityView />,
  agents: () => <AgentsView />,
  skills: () => <SkillsView />,
  guards: () => <ActiveGuardsView />,
  nodes: () => <NodesView />,
  workspace: () => <WorkspaceView />,
  wallet: () => <WalletView />,
  spendGrants: () => <SpendGrantsView />,
  p2p: () => <P2pDashboard />,
  people: () => <CirclesView />,
  dreams: () => <DreamsView />,
  management: () => <ManagementView />,
  models: () => <ModelsView />,
  config: () => <ConfigView />,
  compute: () => <ComputeView />,
  logs: () => <LogsView />,
};

export function AppShell() {
  const activeTab = useUIStore((s) => s.activeTab);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const toolPanelOpen = useUIStore((s) => s.toolPanelOpen);
  const toolPanelWidth = useUIStore((s) => s.toolPanelWidth);

  const isChat = activeTab === "chat";
  const view = VIEW_MAP[activeTab]();

  // One owner for the conversation list: sidebar, palette and usage strip
  // all read the sessions store this keeps fresh.
  useSessionsSync();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* Headless: keeps circles unread/approval counts fresh app-wide for
          the sidebar badge — only the active tab's view is mounted below. */}
      <CirclesGlobalSync />
      {sidebarOpen && <Sidebar />}
      <main
        className="flex-1 flex flex-col min-w-0"
        // The pane is fixed over the right edge; make room for it at its
        // current width, which the person can drag.
        style={isChat && toolPanelOpen ? { marginRight: toolPanelWidth } : undefined}
      >
        {/* With the sidebar closed, the way back is always here; the chat
            header carries its own. */}
        {!sidebarOpen && !isChat && (
          <div className="flex h-10 shrink-0 items-center px-2">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sidebar"
              title="Open sidebar"
              className="grid size-8 place-items-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
            >
              <PanelLeftOpen className="size-[18px]" strokeWidth={1.75} />
            </button>
          </div>
        )}
        <StaleBundleBanner />
        <UpdateBanner />
        <UsageBudgetToasts />
        <OwnerNoticeToasts />
        {/* Main content */}
        <div className="flex-1 overflow-hidden">
          {isControlTab(activeTab) ? <ControlCenter>{view}</ControlCenter> : view}
        </div>
      </main>
      {isChat && toolPanelOpen && <ToolCallPanel />}
      <CommandPalette />
    </div>
  );
}
