import { Sidebar } from "./Sidebar";
import { ConnectionBadge } from "./ConnectionBadge";
import { ChatView } from "../chat/ChatView";
import { ToolCallPanel } from "../chat/ToolCallPanel";
import { OverviewView } from "../overview/OverviewView";
import { ChannelsView } from "../channels/ChannelsView";
import { InstancesView } from "../instances/InstancesView";
import { SessionsView } from "../sessions/SessionsView";
import { UsageView } from "../usage/UsageView";
import { CronView } from "../cron/CronView";
import { AgentsView } from "../agents/AgentsView";
import { SkillsView } from "../skills/SkillsView";
import { NodesView } from "../nodes/NodesView";
import { ProjectsView } from "../projects/ProjectsView";
import { WorkspaceView } from "../workspace/WorkspaceView";
import { WalletView } from "../wallet/WalletView";
import { ConfigView } from "../config/ConfigView";
import { DebugView } from "../debug/DebugView";
import { LogsView } from "../logs/LogsView";
import { P2pDashboard } from "../p2p/P2pDashboard";
import { DreamsView } from "../dreams/DreamsView";
import { ManagementView } from "../management/ManagementView";
import { useUIStore, type TabId } from "../../stores/ui-store";
import { cn } from "../../lib/utils";

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
          isChat && toolPanelOpen && "mr-[550px]"
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
