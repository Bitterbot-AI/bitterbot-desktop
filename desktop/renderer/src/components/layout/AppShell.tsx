import { useUIStore, type TabId } from "../../stores/ui-store";
import { AgentsView } from "../agents/AgentsView";
import { ChannelsView } from "../channels/ChannelsView";
import { ChatView } from "../chat/ChatView";
import { ToolCallPanel } from "../chat/ToolCallPanel";
import { CirclesGlobalSync } from "../circles/CirclesGlobalSync";
import { CirclesView } from "../circles/CirclesView";
import { ConfigView } from "../config/ConfigView";
import { ConnectorsView } from "../connectors/ConnectorsView";
import { CronView } from "../cron/CronView";
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
import { ConnectionBadge } from "./ConnectionBadge";
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
  logs: () => <LogsView />,
};

export function AppShell() {
  const activeTab = useUIStore((s) => s.activeTab);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toolPanelOpen = useUIStore((s) => s.toolPanelOpen);
  const toolPanelWidth = useUIStore((s) => s.toolPanelWidth);

  const isChat = activeTab === "chat";

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
        {/* Title bar area for drag region */}
        <div className="h-8 flex-shrink-0 flex items-center justify-end px-4 drag-region">
          <ConnectionBadge />
        </div>
        <StaleBundleBanner />
        <UpdateBanner />
        <UsageBudgetToasts />
        <OwnerNoticeToasts />
        {/* Main content */}
        <div className="flex-1 overflow-hidden">{VIEW_MAP[activeTab]()}</div>
      </main>
      {isChat && toolPanelOpen && <ToolCallPanel />}
    </div>
  );
}
