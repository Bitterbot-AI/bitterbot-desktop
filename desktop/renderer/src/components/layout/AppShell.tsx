import { cn } from "../../lib/utils";
import { useUIStore, type TabId } from "../../stores/ui-store";
import { AgentsView } from "../agents/AgentsView";
import { ChannelsView } from "../channels/ChannelsView";
import { ChatView } from "../chat/ChatView";
import { ToolCallPanel } from "../chat/ToolCallPanel";
import { ConfigView } from "../config/ConfigView";
import { CronView } from "../cron/CronView";
import { DebugView } from "../debug/DebugView";
import { DreamsView } from "../dreams/DreamsView";
import { InstancesView } from "../instances/InstancesView";
import { LogsView } from "../logs/LogsView";
import { ManagementView } from "../management/ManagementView";
import { NodesView } from "../nodes/NodesView";
import { OverviewView } from "../overview/OverviewView";
import { P2pDashboard } from "../p2p/P2pDashboard";
import { ProjectsView } from "../projects/ProjectsView";
import { SessionsView } from "../sessions/SessionsView";
import { SkillsView } from "../skills/SkillsView";
import { UsageView } from "../usage/UsageView";
import { WalletView } from "../wallet/WalletView";
import { WorkspaceView } from "../workspace/WorkspaceView";
import { ConnectionBadge } from "./ConnectionBadge";
import { Sidebar } from "./Sidebar";

const VIEW_MAP: Record<TabId, () => JSX.Element> = {
  chat: () => <ChatView />,
  overview: () => <OverviewView />,
  channels: () => <ChannelsView />,
  instances: () => <InstancesView />,
  sessions: () => <SessionsView />,
  usage: () => <UsageView />,
  cron: () => <CronView />,
  agents: () => <AgentsView />,
  skills: () => <SkillsView />,
  nodes: () => <NodesView />,
  projects: () => <ProjectsView />,
  workspace: () => <WorkspaceView />,
  wallet: () => <WalletView />,
  p2p: () => <P2pDashboard />,
  dreams: () => <DreamsView />,
  management: () => <ManagementView />,
  config: () => <ConfigView />,
  debug: () => <DebugView />,
  logs: () => <LogsView />,
};

export function AppShell() {
  const activeTab = useUIStore((s) => s.activeTab);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toolPanelOpen = useUIStore((s) => s.toolPanelOpen);

  const isChat = activeTab === "chat";

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {sidebarOpen && <Sidebar />}
      <main
        className={cn(
          "flex-1 flex flex-col min-w-0 transition-all duration-200",
          isChat && toolPanelOpen && "mr-[550px]",
        )}
      >
        {/* Title bar area for drag region */}
        <div className="h-8 flex-shrink-0 flex items-center justify-end px-4 drag-region">
          <ConnectionBadge />
        </div>
        {/* Main content */}
        <div className="flex-1 overflow-hidden">{VIEW_MAP[activeTab]()}</div>
      </main>
      {isChat && toolPanelOpen && <ToolCallPanel />}
    </div>
  );
}
