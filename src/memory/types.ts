export type MemorySource = "memory" | "sessions" | "skills";

export type {
  KnowledgeCrystal,
  CrystalLifecycle,
  CrystalOrigin,
  CrystalSemanticType,
  CrystalGovernance,
  HormonalInfluence,
} from "./crystal-types.js";

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
  crystal?: import("./crystal-types.js").KnowledgeCrystal;
};

export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
};

export type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

export type MemoryProviderStatus = {
  backend: "builtin";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  lastSyncedAt?: number | null;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
  crystals?: Record<string, unknown>;
};

export interface MemorySearchManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]>;
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
  // Dream Engine
  dreamSearch?(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<Array<{ id: string; content: string; score: number; confidence: number }>>;
  dreamStatus?(): Record<string, unknown>;
  // Curiosity Engine
  curiosityState?(): Record<string, unknown> | null;
  curiosityResolve?(targetId: string): boolean;
  // Emotional Anchors
  createEmotionalAnchor?(label: string, description?: string): { id: string; label: string } | null;
  recallEmotionalAnchor?(anchorId: string, influence?: number): boolean;
  listEmotionalAnchors?(): Array<{
    id: string;
    label: string;
    description: string;
    state: { dopamine: number; cortisol: number; oxytocin: number };
    createdAt: number;
    recallCount: number;
  }>;
  // PLAN-10: Skill Seekers (on-demand external skill ingestion)
  getSkillSeekersAdapter?(): {
    isAvailable(): Promise<boolean>;
    budgetRemaining(): number;
    ingestFromSource(source: {
      url: string;
      type?: "docs" | "github" | "pdf" | "video" | "codebase";
      name?: string;
      description?: string;
    }): Promise<{
      ok: boolean;
      error?: string;
      transport?: "native" | "mcp" | "cli" | "python";
      elapsedMs: number;
      ingested: Array<{ action: "accepted" | "quarantined" | "rejected"; skillName?: string }>;
      conflicts: Array<{ severity: "low" | "medium" | "high" }>;
    }>;
  } | null;
}
