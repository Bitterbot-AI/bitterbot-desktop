export type BrowserProfileConfig = {
  /** CDP port for this profile. Allocated once at creation, persisted permanently. */
  cdpPort?: number;
  /** CDP URL for this profile (use for remote Chrome). */
  cdpUrl?: string;
  /** Profile driver (default: bitterbot). */
  driver?: "bitterbot" | "extension";
  /** Profile color (hex). Auto-assigned at creation. */
  color: string;
};
export type BrowserSnapshotDefaults = {
  /** Default snapshot mode (applies when mode is not provided). */
  mode?: "efficient";
};
export type BrowserLiveViewConfig = {
  /** Stream the agent's browser to the Control UI's computer pane. Default: true */
  enabled?: boolean;
  /** Upper bound on frames per second sent to viewers (1-30). Default: 8 */
  maxFps?: number;
  /** JPEG quality of the stream (10-95). Default: 60 */
  quality?: number;
};
export type BrowserReplayConfig = {
  /** Keep a low-rate screenshot record of the agent's browser per session. Default: true */
  enabled?: boolean;
  /** Days to keep a session's recording after its last frame (1-90). Default: 7 */
  retentionDays?: number;
};
export type BrowserConfig = {
  enabled?: boolean;
  /** If false, disable browser act:evaluate (arbitrary JS). Default: true */
  evaluateEnabled?: boolean;
  /** Base URL of the CDP endpoint (for remote browsers). Default: loopback CDP on the derived port. */
  cdpUrl?: string;
  /** Remote CDP HTTP timeout (ms). Default: 1500. */
  remoteCdpTimeoutMs?: number;
  /** Remote CDP WebSocket handshake timeout (ms). Default: max(remoteCdpTimeoutMs * 2, 2000). */
  remoteCdpHandshakeTimeoutMs?: number;
  /** Accent color for the bitterbot browser profile (hex). Default: #FF4500 */
  color?: string;
  /** Override the browser executable path (all platforms). */
  executablePath?: string;
  /** Start Chrome headless (best-effort). Default: false */
  headless?: boolean;
  /** Pass --no-sandbox to Chrome (Linux containers). Default: false */
  noSandbox?: boolean;
  /** If true: never launch; only attach to an existing browser. Default: false */
  attachOnly?: boolean;
  /** Default profile to use when profile param is omitted. Default: "chrome" */
  defaultProfile?: string;
  /** Named browser profiles with explicit CDP ports or URLs. */
  profiles?: Record<string, BrowserProfileConfig>;
  /** Default snapshot options (applied by the browser tool/CLI when unset). */
  snapshotDefaults?: BrowserSnapshotDefaults;
  /** Live view of the agent's browser in the Control UI. */
  liveView?: BrowserLiveViewConfig;
  /** Session replay: screenshots after the agent's page actions (PLAN-53 A6). */
  replay?: BrowserReplayConfig;
};
