import type { DatabaseSync } from "node:sqlite";
import { type FSWatcher } from "chokidar";
import crypto from "node:crypto";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import type { BitterbotConfig } from "../config/config.js";
import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from "../plugins/types.js";
import type { CuriosityState } from "./curiosity-types.js";
import type { DreamStats, SynthesizeFn } from "./dream-types.js";
import type { ManagementNodeService } from "./management-node-service.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ConsolidationEngine, type ConsolidationStats } from "./consolidation.js";
import { CuriosityEngine, type GCCRFRewardResult } from "./curiosity-engine.js";
import {
  DiscoveryAgent,
  type SkillSuggestion,
  type SuggestSkillsConfig,
} from "./discovery-agent.js";
import { DreamEngine, createDefaultSynthesizeFn } from "./dream-engine.js";
import { searchDreamInsights, type DreamSearchResult } from "./dream-search.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js";
import { EpistemicDirectiveEngine } from "./epistemic-directives.js";
import { createExecutionTrackingHook } from "./execution-tracking-hook.js";
import { ExperienceSignalCollector } from "./experience-signal-collector.js";
import { MemoryGovernance } from "./governance.js";
import { HormonalStateManager } from "./hormonal.js";
import {
  bm25RankToScore,
  buildFtsQuery,
  mergeHybridResults,
  mergeHybridResultsRRF,
} from "./hybrid.js";
import { isMemoryPath, normalizeExtraMemoryPaths } from "./internal.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { memoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import { searchKeyword, searchVector } from "./manager-search.js";
import { memoryManagerSyncOps } from "./manager-sync-ops.js";
import { MarketplaceEconomics } from "./marketplace-economics.js";
import { MarketplaceIntelligence } from "./marketplace-intelligence.js";
import { MemStore } from "./mem-store.js";
import { moodCongruentBonus } from "./mood-congruent-boost.js";
import { PeerReputationManager } from "./peer-reputation.js";
import { ProspectiveMemoryEngine } from "./prospective-memory.js";
import { computeRecencyBoost, type RecencyConfig } from "./recency-boost.js";
import { ReconsolidationEngine } from "./reconsolidation.js";
import { MemoryScheduler } from "./scheduler.js";
import { runSeedCrystalMigration, runSkillBootstrap } from "./seed-crystal-migration.js";
import { SessionCoherenceTracker } from "./session-coherence.js";
import {
  extractSessionFacts,
  type ExtractionResult,
  type HormonalBias,
} from "./session-extractor.js";
import { listSessionFilesForAgent } from "./session-files.js";
import { formatHandoverBrief, handoverPath, briefToChunkText } from "./session-handover.js";
import { SkillCrystallizer } from "./skill-crystallizer.js";
import { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { SkillMarketplace } from "./skill-marketplace.js";
import { SkillNetworkBridge, type OrchestratorBridgeLike } from "./skill-network-bridge.js";
import { SkillRefiner } from "./skill-refiner.js";
import { SkillVerifier } from "./skill-verifier.js";
import { assessSomaticMarkers } from "./somatic-markers.js";
import { recordAccess } from "./spacing-effect.js";
import { captureNearbyWeakChunks, shouldTriggerCapture } from "./synaptic-tagging.js";
import { TaskMemoryManager } from "./task-memory.js";
import { UserModelManager } from "./user-model.js";
import {
  buildWorkingMemorySynthesisPrompt,
  buildHeuristicWorkingMemory,
  validateWorkingMemory,
  WORKING_MEMORY_SECTIONS,
  type WorkingMemoryContext,
} from "./working-memory-prompt.js";
import { scanForOpenLoops, getActiveOpenLoops } from "./zeigarnik-effect.js";

const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const BATCH_FAILURE_LIMIT = 2;

const log = createSubsystemLogger("memory");

const INDEX_CACHE = new Map<string, MemoryIndexManager>();

export class MemoryIndexManager implements MemorySearchManager {
  // oxlint-disable-next-line typescript/no-explicit-any
  [key: string]: any;
  private readonly cacheKey: string;
  private readonly cfg: BitterbotConfig;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly settings: ResolvedMemorySearchConfig;
  private provider: EmbeddingProvider;
  private readonly requestedProvider: "openai" | "local" | "gemini" | "voyage" | "auto";
  private fallbackFrom?: "openai" | "local" | "gemini" | "voyage";
  private fallbackReason?: string;
  private openAi?: OpenAiEmbeddingClient;
  private gemini?: GeminiEmbeddingClient;
  private voyage?: VoyageEmbeddingClient;
  private batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  private batchFailureCount = 0;
  private batchFailureLastError?: string;
  private batchFailureLastProvider?: string;
  private batchFailureLock: Promise<void> = Promise.resolve();
  private db: DatabaseSync;
  private readonly sources: Set<MemorySource>;
  private providerKey: string;
  private readonly cache: { enabled: boolean; maxEntries?: number };
  private readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  private readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  private vectorReady: Promise<boolean> | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private sessionWatchTimer: NodeJS.Timeout | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private dirty = false;
  private sessionsDirty = false;
  private sessionsDirtyFiles = new Set<string>();
  private skillsDirty = false;
  private skillsUnsubscribe: (() => void) | null = null;
  private sessionPendingFiles = new Set<string>();
  private sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >();
  private sessionWarm = new Set<string>();
  private syncing: Promise<void> | null = null;
  private consolidationTimer: NodeJS.Timeout | null = null;
  private dreamTimer: NodeJS.Timeout | null = null;
  private dreamInitialTimer: NodeJS.Timeout | null = null;
  private dreamEngine: DreamEngine | null = null;
  private dreamLlmCall: ((prompt: string) => Promise<string>) | null = null;
  private dreamSynthesisLlmCall: ((prompt: string) => Promise<string>) | null = null;
  private curiosityEngine: CuriosityEngine | null = null;
  private hormonalManager: HormonalStateManager | null = null;
  private userModelManager: UserModelManager | null = null;
  private skillRefiner: SkillRefiner | null = null;
  private governance: MemoryGovernance | null = null;
  private taskMemory: TaskMemoryManager | null = null;
  private scheduler: MemoryScheduler | null = null;
  private memStore: MemStore | null = null;
  private skillNetworkBridge: SkillNetworkBridge | null = null;
  private executionTracker: SkillExecutionTracker | null = null;
  private executionTrackingHook:
    | ((event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => void)
    | null = null;
  private experienceCollector: ExperienceSignalCollector | null = null;
  private peerReputationManager: PeerReputationManager | null = null;
  private discoveryAgent: DiscoveryAgent | null = null;
  private marketplaceEconomics: MarketplaceEconomics | null = null;
  private skillMarketplace: SkillMarketplace | null = null;
  managementNodeService: ManagementNodeService | null = null;
  private knowledgeGraph: KnowledgeGraphManager | null = null;
  private reconsolidationEngine: ReconsolidationEngine | null = null;
  private epistemicDirectiveEngine: EpistemicDirectiveEngine | null = null;
  private prospectiveMemoryEngine: ProspectiveMemoryEngine | null = null;
  private skillSeekersAdapter: import("./skill-seekers-adapter.js").SkillSeekersAdapter | null =
    null;

  /**
   * Called by manager-sync-ops after a reindex swaps the database file.
   * Propagates the new DB handle to all subsystems that hold a direct reference.
   */
  protected onDbSwapped(): void {
    if (this.dreamEngine) {
      this.dreamEngine.updateDb(this.db);
    }
    if (this.curiosityEngine) {
      (this.curiosityEngine as any).db = this.db;
    }
    if (this.executionTracker) {
      (this.executionTracker as any).db = this.db;
    }
    if (this.skillRefiner) {
      (this.skillRefiner as any).db = this.db;
    }
    if (this.memStore) {
      (this.memStore as any).db = this.db;
    }
    if (this.skillNetworkBridge) {
      (this.skillNetworkBridge as any).db = this.db;
    }
    if (this.marketplaceEconomics) {
      (this.marketplaceEconomics as any).db = this.db;
    }
    if (this.governance) {
      (this.governance as any).db = this.db;
    }
    if (this.taskMemory) {
      (this.taskMemory as any).db = this.db;
    }
    if (this.peerReputationManager) {
      (this.peerReputationManager as any).db = this.db;
    }
    if (this.experienceCollector) {
      (this.experienceCollector as any).db = this.db;
    }
    if (this.discoveryAgent) {
      (this.discoveryAgent as any).db = this.db;
    }
    if (this.userModelManager) {
      (this.userModelManager as any).db = this.db;
    }
    if (this.hormonalManager) {
      (this.hormonalManager as any).db = this.db;
    }
    if (this.curiosityEngine) {
      this.curiosityEngine.updateDb(this.db);
    }
    // PLAN-9 subsystems
    if (this.knowledgeGraph) {
      (this.knowledgeGraph as any).db = this.db;
    }
    if (this.reconsolidationEngine) {
      (this.reconsolidationEngine as any).db = this.db;
    }
    if (this.epistemicDirectiveEngine) {
      (this.epistemicDirectiveEngine as any).db = this.db;
    }
    if (this.prospectiveMemoryEngine) {
      (this.prospectiveMemoryEngine as any).db = this.db;
    }
    // Re-ensure subsystem schemas on the new DB.
    // The main chunks/meta/dream/curiosity schemas are re-created by ensureSchema()
    // in manager-sync-ops. But subsystem-specific tables (marketplace, peer_reputation,
    // skill_executions) need explicit re-creation here.
    try {
      if (this.marketplaceEconomics) {
        (this.marketplaceEconomics as any).ensureSchema();
      }
      // Skill execution tracking table
      this.db.exec(`CREATE TABLE IF NOT EXISTS skill_executions (
        id TEXT PRIMARY KEY, skill_crystal_id TEXT NOT NULL, session_id TEXT,
        started_at INTEGER NOT NULL, completed_at INTEGER, success INTEGER,
        reward_score REAL, error_type TEXT, error_detail TEXT,
        execution_time_ms INTEGER, tool_calls_count INTEGER, user_feedback INTEGER
      )`);
      // Peer reputation table
      this.db.exec(`CREATE TABLE IF NOT EXISTS peer_reputation (
        peer_pubkey TEXT PRIMARY KEY, peer_id TEXT,
        skills_received INTEGER DEFAULT 0, skills_accepted INTEGER DEFAULT 0,
        skills_rejected INTEGER DEFAULT 0, avg_skill_quality REAL DEFAULT 0,
        reputation_score REAL DEFAULT 0.5, trust_level TEXT DEFAULT 'provisional',
        first_seen_at INTEGER, last_seen_at INTEGER,
        is_banned INTEGER DEFAULT 0, eigentrust_score REAL DEFAULT 0,
        wallet_address TEXT DEFAULT NULL
      )`);
      // Memory audit log
      this.db.exec(`CREATE TABLE IF NOT EXISTS memory_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL,
        detail TEXT, timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )`);
      // Task goals table
      this.db.exec(`CREATE TABLE IF NOT EXISTS task_goals (
        id TEXT PRIMARY KEY, description TEXT NOT NULL,
        progress REAL DEFAULT 0, related_crystal_ids TEXT DEFAULT '[]',
        session_key TEXT, status TEXT DEFAULT 'active',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);
      // Re-run subsystem ensureSchema methods
      if (this.taskMemory) {
        try {
          (this.taskMemory as any).ensureSchema();
        } catch {}
      }
      if (this.governance) {
        try {
          (this.governance as any).ensureSchema?.();
        } catch {}
      }
    } catch (err) {
      log.debug(`schema re-creation after reindex failed: ${String(err)}`);
    }
    log.debug("propagated new DB handle and schemas to subsystems after reindex");
  }

  static async get(params: {
    cfg: BitterbotConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      return null;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}`;
    const existing = INDEX_CACHE.get(key);
    if (existing) {
      return existing;
    }
    const providerResult = await createEmbeddingProvider({
      config: cfg,
      agentDir: resolveAgentDir(cfg, agentId),
      provider: settings.provider,
      remote: settings.remote,
      model: settings.model,
      fallback: settings.fallback,
      local: settings.local,
    });
    const manager = new MemoryIndexManager({
      cacheKey: key,
      cfg,
      agentId,
      workspaceDir,
      settings,
      providerResult,
      purpose: params.purpose,
    });
    INDEX_CACHE.set(key, manager);
    return manager;
  }

  private constructor(params: {
    cacheKey: string;
    cfg: BitterbotConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult: EmbeddingProviderResult;
    purpose?: "default" | "status";
  }) {
    this.cacheKey = params.cacheKey;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.provider = params.providerResult.provider;
    this.requestedProvider = params.providerResult.requestedProvider;
    this.fallbackFrom = params.providerResult.fallbackFrom;
    this.fallbackReason = params.providerResult.fallbackReason;
    this.openAi = params.providerResult.openAi;
    this.gemini = params.providerResult.gemini;
    this.voyage = params.providerResult.voyage;
    this.sources = new Set(params.settings.sources);
    this.db = this.openDatabase();
    this.providerKey = this.computeProviderKey();
    this.cache = {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    };
    this.fts = { enabled: params.settings.query.hybrid.enabled, available: false };
    this.ensureSchema();
    this.vector = {
      enabled: params.settings.store.vector.enabled,
      available: null,
      extensionPath: params.settings.store.vector.extensionPath,
    };
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }
    // Seed Crystal Migration: convert existing MEMORY.md content into crystals (runs once)
    void runSeedCrystalMigration({ db: this.db, workspaceDir: this.workspaceDir }).catch((err) => {
      log.warn(`seed crystal migration failed: ${String(err)}`);
    });
    // Skill Bootstrap: load skills/ directory as frozen skill crystals (runs once)
    void runSkillBootstrap({ db: this.db, workspaceDir: this.workspaceDir }).catch((err) => {
      log.warn(`skill bootstrap failed: ${String(err)}`);
    });
    this.ensureWatcher();
    this.ensureSessionListener();
    this.ensureSkillsListener();
    this.ensureIntervalSync();
    this.ensureConsolidationInterval();
    this.ensureDreamEngine();
    this.ensureCuriosityEngine();
    this.ensureHormonalManager();
    this.ensureUserModelManager();
    this.ensureSkillRefiner();
    this.ensureGovernance();
    this.ensureTaskMemory();
    this.ensureScheduler();
    this.ensureMemStore();
    this.ensureSkillNetworkBridge();
    this.ensurePeerReputationManager();
    const statusOnly = params.purpose === "status";
    this.dirty = this.sources.has("memory") && (statusOnly ? !meta : true);
    this.skillsDirty = this.sources.has("skills") && (statusOnly ? !meta : true);
    this.batch = this.resolveBatchConfig();
  }

  private ensureSkillsListener(): void {
    if (!this.sources.has("skills") || this.skillsUnsubscribe) {
      return;
    }
    this.skillsUnsubscribe = registerSkillsChangeListener(() => {
      if (this.closed) {
        return;
      }
      this.skillsDirty = true;
      this.scheduleWatchSync();
    });
  }

  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return;
    }
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`memory sync failed (session-start): ${String(err)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
    }
  }

  /**
   * Stimulate the hormonal system from a live user message.
   * Call this when a user message arrives (pre-LLM) so the agent's
   * emotional state reacts in real-time, not retroactively at index time.
   */
  stimulateFromLiveMessage(text: string): void {
    if (!this.hormonalManager || !text) {
      return;
    }
    const events = this.hormonalManager.stimulateFromText(text);
    if (events.length > 0) {
      log.debug(`live hormonal stimulation: ${events.join(", ")}`);
      // Check if message stimulation triggered an emotional mini-dream
      this.checkEmotionalDreamTrigger();
    }

    // Plan 7, Phase 2+9: Update coherence tracker + intent from user message
    this.turnCount++;
    this.coherenceTracker.updateIntent(text, this.turnCount);
    this.coherenceTracker.update(
      [{ role: "user", content: text, turn: this.turnCount }],
      this.turnCount,
    );
  }

  // ── Emotional Dream Triggering (Plan 6, Phase 4) ──

  private lastMiniDreamTrigger = 0;
  private readonly miniDreamCooldown = 10 * 60 * 1000; // 10 min

  // Plan 7: Cognitive coherence state
  readonly coherenceTracker = new SessionCoherenceTracker();
  readonly proactiveRecallCooldown = new Map<string, number>();
  private turnCount = 0;

  /**
   * Check hormonal state after stimulation and trigger mini-dream if spike detected.
   * Wired through manager (not direct callback on HormonalStateManager) to keep
   * the manager as the orchestration layer — consistent with existing wiring patterns.
   */
  private checkEmotionalDreamTrigger(): void {
    if (!this.hormonalManager || !this.dreamEngine) {
      return;
    }

    const now = Date.now();
    if (now - this.lastMiniDreamTrigger < this.miniDreamCooldown) {
      return;
    }

    const state = this.hormonalManager.getState();

    if (state.dopamine > 0.7) {
      this.lastMiniDreamTrigger = now;
      void this.dreamEngine
        .runMiniDream("dopamine_spike")
        .catch((err) => log.warn(`mini-dream failed: ${String(err)}`));
    } else if (state.cortisol > 0.8) {
      this.lastMiniDreamTrigger = now;
      void this.dreamEngine
        .runMiniDream("cortisol_spike")
        .catch((err) => log.warn(`mini-dream failed: ${String(err)}`));
    }

    // Plan 7, Phase 7: State-based emotional anchor recall
    // When current emotional state matches a stored anchor, blend it mildly
    if (this.hormonalManager) {
      try {
        const similar = this.hormonalManager.findSimilarAnchors(0.85, 1);
        if (similar.length > 0) {
          const { anchor, similarity } = similar[0]!;
          this.hormonalManager.recallAnchor(anchor.id, 0.15);
          log.debug("associative anchor recall", {
            label: anchor.label,
            similarity: similarity.toFixed(2),
          });
        }
      } catch {
        // findSimilarAnchors not available yet — non-critical
      }
    }
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    },
  ): Promise<MemorySearchResult[]> {
    void this.warmSession(opts?.sessionKey);
    if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty || this.skillsDirty)) {
      void this.sync({ reason: "search" }).catch((err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      });
    }
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const hybrid = this.settings.query.hybrid;
    // RRF scores are on a different scale (~0.01–0.03 for k=60) than cosine
    // similarity (~0.3–0.9). When using RRF, disable minScore filtering since
    // rank-based fusion already handles relevance ranking effectively.
    const minScore =
      hybrid.mergeStrategy === "rrf" ? 0 : (opts?.minScore ?? this.settings.query.minScore);
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    const keywordResults = hybrid.enabled
      ? await this.searchKeyword(cleaned, candidates).catch(() => [])
      : [];

    const queryVec = (await this.embedQueryWithTimeout(cleaned)) as number[];
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates, cleaned).catch(() => [])
      : [];

    const useRrf = hybrid.mergeStrategy === "rrf";

    // Legacy importance boost — only active when using weighted merge strategy.
    // With RRF, importance is decoupled from retrieval (used only for lifecycle).
    const importanceWeight = useRrf ? 0 : this.settings.query.importanceWeight;
    const applyImportanceBoost = <T extends { score: number; importanceScore?: number }>(
      items: T[],
    ): T[] => {
      if (importanceWeight <= 0) {
        return items;
      }
      return items.map((r) => {
        const imp = r.importanceScore ?? 1.0;
        const boost = 1 - importanceWeight + importanceWeight * imp;
        return { ...r, score: r.score * boost };
      });
    };

    let results: MemorySearchResult[];
    if (!hybrid.enabled) {
      const boosted = applyImportanceBoost(vectorResults);
      boosted.sort((a, b) => b.score - a.score);
      results = boosted.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    } else if (useRrf) {
      // RRF merge: rank-based fusion that doesn't require comparable score scales.
      // Importance is NOT applied — it governs memory lifecycle only.
      const typedVector = vectorResults as Array<
        (typeof vectorResults)[number] & {
          id: string;
          importanceScore: number;
          updatedAt: number;
          lastAccessedAt: number | null;
          emotionalValence: number | null;
        }
      >;
      const typedKeyword = keywordResults as Array<
        (typeof keywordResults)[number] & {
          id: string;
          textScore: number;
          importanceScore: number;
          updatedAt: number;
          lastAccessedAt: number | null;
          emotionalValence: number | null;
        }
      >;
      const merged = mergeHybridResultsRRF({
        vector: typedVector.map((r) => ({
          id: r.id,
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          source: r.source,
          snippet: r.snippet,
          vectorScore: r.score,
          importanceScore: r.importanceScore,
          updatedAt: r.updatedAt,
          lastAccessedAt: r.lastAccessedAt,
          emotionalValence: r.emotionalValence,
        })),
        keyword: typedKeyword.map((r) => ({
          id: r.id,
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          source: r.source,
          snippet: r.snippet,
          textScore: r.textScore,
          importanceScore: r.importanceScore,
          updatedAt: r.updatedAt,
          lastAccessedAt: r.lastAccessedAt,
          emotionalValence: r.emotionalValence,
        })),
      });

      // Hormonal retrieval modulation: emotional state influences what memories surface.
      // Cortisol (stress) sharpens focus on recent memories via recency bias.
      // Dopamine boosts importance weight slightly (optimism lifts all boats).
      const hormonalMod = this.hormonalManager?.getRetrievalModulation();

      // Apply recency boost: recent memories get a temporal advantage
      const recencyCfg: RecencyConfig = this.settings.query.recency;
      if (recencyCfg.enabled) {
        // Cortisol-driven recency bias: stressed agent focuses more on recent memories
        const effectiveRecencyCfg = hormonalMod
          ? { ...recencyCfg, alpha: recencyCfg.alpha * hormonalMod.recencyBias }
          : recencyCfg;
        for (const entry of merged) {
          entry.score *= computeRecencyBoost(
            entry.updatedAt ?? Date.now(),
            entry.lastAccessedAt ?? null,
            effectiveRecencyCfg,
          );
        }
      }

      // Emotional retrieval boost: emotionally charged memories surface more easily.
      // In humans, mood-congruent memory recall is a well-documented phenomenon.
      for (const entry of merged) {
        const valence = entry.emotionalValence ?? 0;
        if (Math.abs(valence) > 0.3) {
          entry.score *= 1 + Math.abs(valence) * 0.1;
        }
      }

      // PLAN-9 GAP-6: Mood-congruent retrieval — hormonal state biases which memories surface
      if (hormonalMod && this.hormonalManager) {
        const hState = this.hormonalManager.getState();
        for (const entry of merged) {
          const bonus = moodCongruentBonus({
            hormonalState: hState,
            emotionalValence: entry.emotionalValence ?? null,
            semanticType: ((entry as Record<string, unknown>).semanticType as string) ?? null,
          });
          if (bonus > 0) {
            entry.score *= 1 + bonus;
          }
        }
      }

      // Plan 7, Phase 3: Temporal awareness — query intent determines how age affects scoring.
      // "What am I working on?" strongly favors recent; "when did I..." favors older.
      try {
        const { detectTemporalIntent, temporalRelevanceMultiplier } =
          await import("./temporal-scoring.js");
        const temporalIntent = detectTemporalIntent(query);
        if (temporalIntent !== "timeless") {
          for (const entry of merged) {
            entry.score *= temporalRelevanceMultiplier({
              intent: temporalIntent,
              epistemicLayer:
                ((entry as Record<string, unknown>).epistemicLayer as string | null) ?? null,
              createdAt: ((entry as Record<string, unknown>).createdAt as number) ?? Date.now(),
              updatedAt: entry.updatedAt ?? null,
            });
          }
        }
      } catch {
        // temporal-scoring module not available — non-critical
      }

      merged.sort((a, b) => b.score - a.score);

      results = merged
        .filter((entry) => entry.score >= minScore)
        .slice(0, maxResults)
        .map((entry) => ({
          path: entry.path,
          startLine: entry.startLine,
          endLine: entry.endLine,
          score: entry.score,
          snippet: entry.snippet,
          source: entry.source as MemorySource,
        }));
    } else {
      // Legacy weighted merge: score = vectorWeight * vectorScore + textWeight * textScore
      const merged = this.mergeHybridResults({
        vector: vectorResults,
        keyword: keywordResults,
        vectorWeight: hybrid.vectorWeight,
        textWeight: hybrid.textWeight,
      });
      const boosted = applyImportanceBoost(merged);
      boosted.sort((a, b) => b.score - a.score);
      results = boosted.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    this.trackSearchHits(results);

    // Limbic memory bridge (Plan 6, Phase 5): retrieved memories influence emotional state.
    // This creates a feedback loop: emotional state → retrieval bias → recalled content → hormones.
    if (this.hormonalManager && results.length > 0) {
      try {
        // Query emotional valence and semantic type for retrieved chunks
        const params: (string | number)[] = [];
        for (const r of results) {
          params.push(r.path, r.startLine, r.endLine);
        }
        const whereClause = results
          .map(() => "(path = ? AND start_line = ? AND end_line = ?)")
          .join(" OR ");
        const retrieved = this.db
          .prepare(`SELECT emotional_valence, semantic_type FROM chunks WHERE ${whereClause}`)
          .all(...params) as Array<{
          emotional_valence: number | null;
          semantic_type: string | null;
        }>;

        if (retrieved.length > 0) {
          const avgValence =
            retrieved.reduce((sum, r) => sum + (r.emotional_valence ?? 0), 0) / retrieved.length;

          if (avgValence > 0.3) {
            this.hormonalManager.stimulate("recall_positive");
          } else if (avgValence < -0.3) {
            this.hormonalManager.stimulate("recall_negative");
          }

          const hasRelational = retrieved.some(
            (r) => r.semantic_type === "relationship" || r.semantic_type === "preference",
          );
          if (hasRelational) {
            this.hormonalManager.stimulate("recall_relational");
          }

          // Check if limbic recall triggered an emotional mini-dream
          this.checkEmotionalDreamTrigger();
        }
      } catch {
        // Non-critical: limbic bridge failure shouldn't break search
      }
    }

    // Curiosity Engine: record search query for gap detection
    if (this.curiosityEngine && hasVector && queryVec.length > 0) {
      try {
        const topScore = results.length > 0 ? results[0]!.score : 0;
        const meanScore =
          results.length > 0 ? results.reduce((sum, r) => sum + r.score, 0) / results.length : 0;
        this.recordSearchQueryCuriosity(cleaned, queryVec, results.length, topScore, meanScore);
      } catch {
        // Non-critical
      }
    }

    return results;
  }

  private trackSearchHits(results: MemorySearchResult[]): void {
    if (results.length === 0) {
      return;
    }
    const now = Date.now();
    try {
      const stmt = this.db.prepare(
        `UPDATE chunks SET access_count = access_count + 1, last_accessed_at = ?
         WHERE path = ? AND start_line = ? AND end_line = ?`,
      );
      for (const result of results) {
        stmt.run(now, result.path, result.startLine, result.endLine);
      }

      // PLAN-9: Spacing effect — record access timestamps for spaced repetition scoring
      // PLAN-9: Reconsolidation — mark retrieved chunks as labile
      const idQuery = this.db.prepare(
        `SELECT id FROM chunks WHERE path = ? AND start_line = ? AND end_line = ?`,
      );
      for (const result of results) {
        try {
          const row = idQuery.get(result.path, result.startLine, result.endLine) as
            | { id: string }
            | undefined;
          if (row) {
            recordAccess(this.db, row.id);
            this.reconsolidationEngine?.markLabile(row.id);
          }
        } catch {
          // Non-critical
        }
      }
    } catch {
      // Non-critical: access tracking failure shouldn't break search
    }
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
    queryText?: string,
  ): Promise<Array<MemorySearchResult & { id: string; importanceScore: number }>> {
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      queryText,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      sourceFilterVec: this.buildSourceFilter("c"),
      sourceFilterChunks: this.buildSourceFilter(),
    });
    return results.map(
      (entry) => entry as MemorySearchResult & { id: string; importanceScore: number },
    );
  }

  private buildFtsQuery(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<
    Array<MemorySearchResult & { id: string; textScore: number; importanceScore: number }>
  > {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const sourceFilter = this.buildSourceFilter("f");
    const results = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel: this.provider.model,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      bm25RankToScore,
    });
    return results.map(
      (entry) =>
        entry as MemorySearchResult & { id: string; textScore: number; importanceScore: number },
    );
  }

  private mergeHybridResults(params: {
    vector: Array<MemorySearchResult & { id: string; importanceScore: number }>;
    keyword: Array<MemorySearchResult & { id: string; textScore: number; importanceScore: number }>;
    vectorWeight: number;
    textWeight: number;
  }): Array<MemorySearchResult & { importanceScore?: number }> {
    const merged = mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
        importanceScore: r.importanceScore,
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
        importanceScore: r.importanceScore,
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
    });
    return merged.map((entry) => entry as MemorySearchResult & { importanceScore?: number });
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing ?? Promise.resolve();
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const rawPath = params.relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }
    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceDir, rawPath);
    const relPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");
    const inWorkspace =
      relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
    const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
    let allowedAdditional = false;
    if (!allowedWorkspace && this.settings.extraPaths.length > 0) {
      const additionalPaths = normalizeExtraMemoryPaths(
        this.workspaceDir,
        this.settings.extraPaths,
      );
      for (const additionalPath of additionalPaths) {
        try {
          const stat = await fs.lstat(additionalPath);
          if (stat.isSymbolicLink()) {
            continue;
          }
          if (stat.isDirectory()) {
            if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
              allowedAdditional = true;
              break;
            }
            continue;
          }
          if (stat.isFile()) {
            if (absPath === additionalPath && absPath.endsWith(".md")) {
              allowedAdditional = true;
              break;
            }
          }
        } catch {}
      }
    }
    if (!allowedWorkspace && !allowedAdditional) {
      throw new Error("path required");
    }
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    const stat = await fs.lstat(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("path required");
    }
    const content = await fs.readFile(absPath, "utf-8");
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): MemoryProviderStatus {
    const sourceFilter = this.buildSourceFilter();
    const files = this.db
      .prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const sourceCounts = (() => {
      const sources = Array.from(this.sources);
      if (sources.length === 0) {
        return [];
      }
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      const fileRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of fileRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.files = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      const chunkRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of chunkRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.chunks = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      return sources.map((source) => Object.assign({ source }, bySource.get(source)!));
    })();
    return {
      backend: "builtin",
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty || this.sessionsDirty || this.skillsDirty,
      lastSyncedAt: this.lastSyncedAt ?? null,
      ...(this.dirty || this.sessionsDirty || this.skillsDirty
        ? { warning: "Unindexed changes detected — run sync for up-to-date results" }
        : {}),
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      provider: this.provider.id,
      model: this.provider.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts,
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
                  | { c: number }
                  | undefined
              )?.c ?? 0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      batch: {
        enabled: this.batch.enabled,
        failures: this.batchFailureCount,
        limit: BATCH_FAILURE_LIMIT,
        wait: this.batch.wait,
        concurrency: this.batch.concurrency,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        lastError: this.batchFailureLastError,
        lastProvider: this.batchFailureLastProvider,
      },
      // ── Knowledge Crystal extended status ──
      crystals: this.getCrystalStatus(),
    };
  }

  private getCrystalStatus(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // Lifecycle counts — account for importance-based generated→activated promotion
    try {
      const lifecycleRows = this.db
        .prepare(
          `SELECT
             CASE
               WHEN COALESCE(lifecycle, 'generated') = 'generated'
                    AND COALESCE(importance_score, 1.0) >= 0.8
                 THEN 'activated'
               ELSE COALESCE(lifecycle, 'generated')
             END as lc,
             COUNT(*) as c
           FROM chunks GROUP BY lc`,
        )
        .all() as Array<{ lc: string; c: number }>;
      const lifecycleCounts: Record<string, number> = {};
      for (const row of lifecycleRows) {
        lifecycleCounts[row.lc] = row.c;
      }
      result.lifecycleCounts = lifecycleCounts;
    } catch {}

    // Semantic type counts
    try {
      const semanticRows = this.db
        .prepare(
          `SELECT COALESCE(semantic_type, 'general') as st, COUNT(*) as c FROM chunks GROUP BY st`,
        )
        .all() as Array<{ st: string; c: number }>;
      const semanticCounts: Record<string, number> = {};
      for (const row of semanticRows) {
        semanticCounts[row.st] = row.c;
      }
      result.semanticTypeCounts = semanticCounts;
    } catch {}

    // Hormonal state with mood + emotional briefing + response modulation + trajectory
    const hormones = this.hormonalState();
    if (hormones) {
      const mood = describeHormonalMood(hormones);
      const emotionalBriefing = this.hormonalManager?.emotionalBriefing() ?? "";
      const modulation = this.hormonalManager?.responseModulation() ?? null;
      const trajectory = this.hormonalManager?.emotionalTrajectory() ?? null;
      result.hormonalState = {
        ...hormones,
        mood,
        emotionalBriefing,
        ...(trajectory ? { trajectory } : {}),
        ...(modulation
          ? {
              responseGuidance: modulation.briefing,
              tone: {
                warmth: modulation.warmth,
                energy: modulation.energy,
                focus: modulation.focus,
                playfulness: modulation.playfulness,
                verbosity: modulation.verbosity,
                curiosityExpression: modulation.curiosityExpression,
                assertiveness: modulation.assertiveness,
                empathyExpression: modulation.empathyExpression,
              },
            }
          : {}),
      };
      // Emotional anchors
      const anchors = this.hormonalManager?.getAnchors() ?? [];
      if (anchors.length > 0) {
        result.emotionalAnchors = anchors.slice(0, 5).map((a) => ({
          id: a.id,
          label: a.label,
          mood: describeHormonalMood(a.state),
          recallCount: a.recallCount,
          age: Math.round((Date.now() - a.createdAt) / 60000) + "m ago",
        }));
      }
    }

    // Active goals
    try {
      const goals = this.getActiveGoals();
      result.activeGoals = goals.map((g) => ({
        id: g.id,
        description: g.description.slice(0, 80),
        progress: g.progress,
        status: g.status,
      }));
    } catch {}

    // Curiosity summary with top targets
    try {
      const curiosity = this.curiosityState();
      if (curiosity) {
        const openTargets = curiosity.targets.filter((t) => t.resolvedAt === null);
        result.curiosity = {
          regions: curiosity.regions.length,
          openTargets: openTargets.length,
          resolvedTargets: curiosity.targets.filter((t) => t.resolvedAt !== null).length,
          topTargets: openTargets
            .toSorted((a, b) => b.priority - a.priority)
            .slice(0, 5)
            .map((t) => ({
              type: t.type,
              description: t.description.slice(0, 120),
              priority: t.priority,
            })),
          recentEmergence: curiosity.recentEmergence?.slice(0, 3).map((e) => ({
            type: e.type,
            description: e.description.slice(0, 120),
            strength: e.strength,
          })),
        };
      }
    } catch {}

    // Dream summary
    try {
      result.dream = this.dreamStatus();
    } catch {}

    // User preferences
    try {
      const profile = this.userProfile();
      if (profile) {
        result.userProfile = {
          preferenceCount: profile.preferences.length,
          patternCount: profile.patterns.length,
          topPreferences: profile.preferences.slice(0, 5).map((p) => `${p.key}: ${p.value}`),
        };
      }
    } catch {}

    // Governance stats
    try {
      result.governance = this.governanceStats();
    } catch {}

    // Scheduler budget
    try {
      result.scheduler = this.schedulerStatus();
    } catch {}

    return result;
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    return this.ensureVectorReady();
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      await this.embedBatchWithRetry(["ping"]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  consolidate(): ConsolidationStats | null {
    const consolidationCfg = this.cfg.memory?.consolidation;
    if (consolidationCfg?.enabled === false) {
      return null;
    }
    const emotionalCfg = this.cfg.memory?.emotional;
    // Scale forget threshold inversely with maturity: young agents (maturity=0)
    // use the default threshold; mature agents (maturity=1) use half the threshold,
    // becoming more retentive as they accumulate personality-defining memories.
    const baseForgetThreshold = consolidationCfg?.forgetThreshold ?? 0.02;
    const maturity = this.curiosityEngine?.getMaturity() ?? 0;
    const scaledForgetThreshold = baseForgetThreshold * (1 - maturity * 0.5);
    // Wire real-time hormonal state into consolidation: cortisol → decay resistance,
    // dopamine → reward memory protection, oxytocin → relational memory protection
    const hormonalMod = this.hormonalManager?.getConsolidationModulation();
    const engine = new ConsolidationEngine(this.db, {
      decayRate: consolidationCfg?.decayRate,
      promoteThreshold: consolidationCfg?.promoteThreshold,
      forgetThreshold: scaledForgetThreshold,
      mergeOverlapThreshold: hormonalMod?.mergeThreshold ?? consolidationCfg?.mergeOverlapThreshold,
      emotionDecayResistance: hormonalMod
        ? hormonalMod.decayResistance
        : emotionalCfg?.enabled !== false
          ? (emotionalCfg?.decayResistance ?? 0.5)
          : 0,
    });
    return engine.run();
  }

  private ensureConsolidationInterval(): void {
    const consolidationCfg = this.cfg.memory?.consolidation;
    if (consolidationCfg?.enabled === false) {
      return;
    }
    const minutes = consolidationCfg?.intervalMinutes ?? 30;
    if (minutes <= 0 || this.consolidationTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.consolidationTimer = setInterval(() => {
      try {
        // 0. First Breath: trigger immediate RLM synthesis for new agents with no Phenotype
        this.shouldTriggerFirstBreath()
          .then(async (should) => {
            if (should) {
              log.info(
                "First Breath triggered — running immediate RLM micro-cycle for nascent agent",
              );
              const stats: DreamStats = {
                cycle: {
                  cycleId: `first-breath-${Date.now()}`,
                  startedAt: Date.now(),
                  completedAt: Date.now(),
                  durationMs: 0,
                  state: "AWAKENING" as const,
                  clustersProcessed: 0,
                  insightsGenerated: 0,
                  chunksAnalyzed: 0,
                  llmCallsUsed: 0,
                  error: null,
                },
                newInsights: [],
              };
              await this.rewriteWorkingMemory(stats);
              log.info("First Breath complete — Phenotype and Bond sections created");
            }
          })
          .catch((err) => {
            log.debug(`First Breath check failed: ${String(err)}`);
          });
        // 1. Hormonal decay
        this.hormonalManager?.decay();
        // 2. Consolidation (Ebbinghaus decay + merge)
        this.consolidate();
        // 3. Curiosity engine (rebuild regions, detect gaps)
        const curiosityResult = this.curiosityEngine?.run();
        // 3b. Emit top exploration targets as network queries
        if (curiosityResult && curiosityResult.targets > 0 && this.skillNetworkBridge) {
          this.emitTopTargetsAsQueries();
        }
        // 4. Governance: enforce TTL lifespan policies
        this.governance?.enforceLifespan();
        // 5. Task memory: mark stalled goals
        this.taskMemory?.markStalledGoals();
        // 6. Auto-scratch from hormonal spikes (belt AND suspenders)
        this.autoScratchFromHormonalSpike();
        // 7. EigenTrust + anomaly detection (Task 6)
        if (this.peerReputationManager) {
          this.peerReputationManager
            .refreshEigenTrustScores(this.skillNetworkBridge ? undefined : null)
            .catch((err) => {
              log.warn(`EigenTrust refresh failed: ${String(err)}`);
            });
          this.peerReputationManager.detectAnomalies();
          // 7b. Update peer quality scores from execution outcomes
          try {
            const peers = this.db
              .prepare(`SELECT DISTINCT pubkey FROM peer_reputation WHERE skills_accepted > 0`)
              .all() as Array<{ pubkey: string }>;
            for (const peer of peers) {
              this.peerReputationManager.updatePeerQuality(peer.pubkey);
            }
          } catch (err) {
            log.debug(`peer quality update failed: ${String(err)}`);
          }
        }
        // 8. Crystallize successful execution patterns into skills
        if (this.executionTracker) {
          const crystallizer = new SkillCrystallizer(this.db, this.executionTracker);
          const newSkills = crystallizer.crystallizePatterns();
          if (newSkills > 0) {
            log.info(`crystallized ${newSkills} new skill(s) from execution patterns`);
          }
        }
        // 9. Decay steering rewards to prevent unbounded accumulation
        {
          const engine = new ConsolidationEngine(this.db);
          engine.decaySteeringRewards();
        }
        // 10. GCCRF: batch-score pending chunks and persist state (via unified CuriosityEngine)
        this.curiosityEngine?.scorePendingChunks();
        // 11. Marketplace: refresh listings and prices
        if (this.marketplaceEconomics) {
          const repScore = this.getOwnReputationScore();
          const listedCount = this.marketplaceEconomics.refreshListings(repScore);
          if (listedCount > 0) {
            log.debug(`Marketplace: ${listedCount} skills listed`);
          }

          // 11b. Check for new sales and emit earnings notification
          const recentSales = this.marketplaceEconomics.getRecentSales(Date.now() - ms);
          if (recentSales.count > 0) {
            const summary = this.marketplaceEconomics.getEconomicSummary();
            this.emitEvent?.("marketplace:earnings", {
              newSales: recentSales.count,
              totalEarningsUsdc: summary.totalEarningsUsdc,
              sessionEarningsUsdc: recentSales.totalUsdc,
              timestamp: Date.now(),
            });

            // Stimulate hormones — earning money is a dopamine event.
            // Log-scale the dopamine hit to prevent "manic state" from viral sales.
            // 50 sales overnight would peg dopamine to 1.0 without capping.
            // Cap at 3 stimulations per consolidation cycle. (Gemini peer review fix)
            const stimCount = Math.min(3, Math.ceil(Math.log10(recentSales.count + 1)));
            for (let i = 0; i < stimCount; i++) {
              this.hormonalManager?.stimulate("marketplace_sale");
            }

            this.appendDreamJournalLine(
              `**Marketplace:** ${recentSales.count} skill sale(s) — earned $${recentSales.totalUsdc.toFixed(4)} USDC`,
            );
          }

          // 11c. Plan 8, Phase 1: Process revenue payment queue (release held + dispatch)
          try {
            const released = this.marketplaceEconomics.releaseHeldPayments();
            if (released > 0) {
              log.info(`revenue queue: ${released} payments released from 48h hold`);
            }

            // Observability: log revenue queue stats
            const queueStats = this.marketplaceEconomics.getRevenueQueueStats();
            if (queueStats.held + queueStats.released + queueStats.disputed > 0) {
              log.debug("revenue queue status", queueStats);
            }
          } catch {
            // Revenue queue processing non-critical
          }
        }
        // ── PLAN-9 Memory Supremacy: consolidation-phase integrations ──
        // 12. Reconsolidation: restabilize expired labile chunks
        if (this.reconsolidationEngine) {
          this.reconsolidationEngine.restabilizeExpired();
        }
        // 13. Knowledge Graph: prune stale relationships
        if (this.knowledgeGraph) {
          this.knowledgeGraph.pruneStaleRelationships();
        }
        // 14. Epistemic Directives: detect contradictions and expire old directives
        if (this.epistemicDirectiveEngine) {
          this.epistemicDirectiveEngine.detectContradictions();
          this.epistemicDirectiveEngine.expireOld();
        }
        // 15. Prospective Memory: clean expired
        if (this.prospectiveMemoryEngine) {
          this.prospectiveMemoryEngine.cleanExpired();
        }
      } catch (err) {
        log.warn(`memory consolidation failed: ${String(err)}`);
      }
    }, ms);
  }

  // --- Dream Engine ---

  private ensureDreamEngine(): void {
    const dreamCfg = this.cfg.memory?.dream;
    if (dreamCfg?.enabled === false) {
      return;
    }

    // Build a real llmCall function if one isn't already provided.
    // IMPORTANT: llmCall functions must NOT be placed on the config object
    // because the agent framework may structuredClone the config, and
    // functions are not cloneable. We keep them as local variables and
    // pass a sanitized config (without functions) to the DreamEngine.
    const builtLlmCall =
      dreamCfg?.llmCall ?? this.buildLlmCallFn(dreamCfg?.model ?? "openai/gpt-4o-mini");
    const builtSynthesisLlmCall =
      dreamCfg?.synthesisLlmCall ??
      (dreamCfg?.synthesisModel ? this.buildLlmCallFn(dreamCfg.synthesisModel) : null);

    // Build a config WITHOUT function properties (safe for structuredClone)
    const {
      llmCall: _lc,
      synthesisLlmCall: _slc,
      localLlmCall: _llc,
      ...safeDreamCfg
    } = dreamCfg ?? {};

    // Reassemble a config with functions for the DreamEngine constructor only
    const engineCfg = {
      ...safeDreamCfg,
      ...(builtLlmCall ? { llmCall: builtLlmCall } : {}),
      ...(builtSynthesisLlmCall ? { synthesisLlmCall: builtSynthesisLlmCall } : {}),
    };

    let synthesizeFn: SynthesizeFn;
    if (builtLlmCall) {
      synthesizeFn = createDefaultSynthesizeFn(builtLlmCall);
    } else if (safeDreamCfg.synthesisMode === "llm" || safeDreamCfg.synthesisMode === "both") {
      log.warn("dream engine: no llmCall available; forcing heuristic mode");
      engineCfg.synthesisMode = "heuristic";
      synthesizeFn = createDefaultSynthesizeFn(async () => "[]");
    } else {
      synthesizeFn = createDefaultSynthesizeFn(async () => "[]");
    }

    const embedBatchFn = async (texts: string[]) => {
      return await this.embedBatchWithRetry(texts);
    };

    this.dreamLlmCall = builtLlmCall;
    this.dreamSynthesisLlmCall = builtSynthesisLlmCall;
    this.dreamEngine = new DreamEngine(this.db, engineCfg, synthesizeFn, embedBatchFn);

    if (this.hormonalManager) {
      this.dreamEngine.setHormonalStateGetter(() => this.hormonalManager?.getState() ?? null);
      this.dreamEngine.setHormonalManager(this.hormonalManager);
    }

    // Wire execution tracker for research mode
    if (!this.executionTracker) {
      this.executionTracker = new SkillExecutionTracker(this.db);
    }
    this.dreamEngine.setExecutionTracker(this.executionTracker);

    // Plan 7, Phase 10: Wire GCCRF reward function for FSHO alpha coupling
    // (CuriosityEngine now exposes updateFshoR/getFshoRAvg/getFshoCoupledAlpha)
    if (this.curiosityEngine) {
      this.dreamEngine.setGccrfRewardFunction(this.curiosityEngine);
    }

    // Plan 8, Phase 7: Wire marketplace intelligence for demand-driven dreams
    this.dreamEngine.setMarketplaceIntelligence(new MarketplaceIntelligence(this.db));

    // PLAN-10: Skill Seekers adapter is wired via the async .then() callback
    // in ensureSkillNetworkBridge() — no need to wire here (adapter may not exist yet).

    const minutes = dreamCfg?.intervalMinutes ?? 120;
    if (minutes > 0) {
      const ms = minutes * 60 * 1000;

      // Trigger-on-start: run the first dream cycle after a short initial delay
      // instead of waiting the full interval. This ensures dreams actually fire
      // even when hot reloads reset the timer every 30-60 minutes.
      const initialDelayMs = (dreamCfg?.initialDelayMinutes ?? 5) * 60 * 1000;
      this.dreamInitialTimer = setTimeout(() => {
        this.dreamInitialTimer = null;
        log.info("initial dream cycle starting (trigger-on-start)");
        void this.dream().catch((err) => {
          log.warn(`initial dream cycle failed: ${String(err)}`);
        });
      }, initialDelayMs);
      // Don't let the initial timer prevent Node from exiting
      if (this.dreamInitialTimer.unref) {
        this.dreamInitialTimer.unref();
      }

      this.dreamTimer = setInterval(() => {
        void this.dream().catch((err) => {
          log.warn(`dream cycle failed: ${String(err)}`);
        });
      }, ms);
    }
  }

  /**
   * Build a standalone LLM call function from a "provider/model" string.
   * Returns null if the model can't be resolved or auth is unavailable.
   */
  private buildLlmCallFn(modelSpec: string): ((prompt: string) => Promise<string>) | null {
    const parts = modelSpec.split("/");
    if (parts.length < 2) {
      return null;
    }
    const provider = parts[0]!;
    const modelId = parts.slice(1).join("/");

    try {
      // Lazy imports to avoid circular deps and keep cold path fast
      const resolveModelFn = async () => {
        const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");
        const { getApiKeyForModel } = await import("../agents/model-auth.js");
        const resolved = resolveModel(provider, modelId, undefined, this.cfg);
        if (!resolved.model) {
          return null;
        }
        const auth = await getApiKeyForModel({ model: resolved.model, cfg: this.cfg });
        return { model: resolved.model, apiKey: auth?.apiKey };
      };

      return async (prompt: string): Promise<string> => {
        const { completeSimple } = await import("@mariozechner/pi-ai");
        const ctx = await resolveModelFn();
        if (!ctx) {
          throw new Error(`Cannot resolve model: ${modelSpec}`);
        }

        const res = await completeSimple(
          ctx.model,
          {
            messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
          },
          {
            apiKey: ctx.apiKey,
            maxTokens: 2048,
            temperature: 0.7,
          },
        );

        return (
          res.content
            ?.filter((b: { type: string }) => b.type === "text")
            .map((b: { type: string; text?: string }) => b.text ?? "")
            .join("\n") ?? ""
        );
      };
    } catch (err) {
      log.warn(`Failed to build LLM call for ${modelSpec}: ${String(err)}`);
      return null;
    }
  }

  async dream(): Promise<DreamStats | null> {
    if (!this.dreamEngine) {
      return null;
    }
    const stats = await this.dreamEngine.run();

    if (stats && stats.newInsights.length > 0) {
      // Post-dream curiosity assessment
      if (this.curiosityEngine) {
        for (const insight of stats.newInsights) {
          try {
            this.curiosityEngine.assessDreamInsight(insight);
          } catch {}
        }
      }

      // Dream journal: write a narrative entry for the dream cycle
      if (stats.cycle.state !== "DORMANT" || stats.newInsights.length > 0) {
        try {
          this.writeDreamJournal(stats);
        } catch (err) {
          log.debug(`dream journal write failed: ${String(err)}`);
        }
      }

      // Persist GCCRF state after each dream cycle (dream cycles drive maturity)
      this.curiosityEngine?.saveGCCRFState();

      // Skill refinement evaluation (for mutation and research mode insights)
      if (this.skillRefiner) {
        const refinableInsights = stats.newInsights.filter(
          (i) => i.mode === "mutation" || i.mode === "research",
        );
        if (refinableInsights.length > 0) {
          for (const insight of refinableInsights) {
            const sourceId = insight.sourceChunkIds[0];
            if (!sourceId) {
              continue;
            }
            try {
              const sourceChunk = this.db
                .prepare(`SELECT id, text FROM chunks WHERE id = ?`)
                .get(sourceId) as { id: string; text: string } | undefined;
              if (sourceChunk) {
                this.skillRefiner.evaluateMutations(sourceChunk, [insight]);
              }
            } catch {}
          }
        }
      }
    }

    // Post-dream: run discovery agent to find skill relationships
    if (stats && stats.newInsights.length > 0) {
      try {
        if (!this.discoveryAgent) {
          const llmCall = this.dreamLlmCall ?? this.buildLlmCallFn("openai/gpt-4o-mini");
          this.discoveryAgent = new DiscoveryAgent(this.db, llmCall);
        }
        const discovery = await this.discoveryAgent.runCycle();
        if (discovery.edgesDiscovered > 0) {
          log.info("discovery: found skill relationships", {
            edges: discovery.edgesDiscovered,
            prerequisites: discovery.prerequisitesFound,
            composites: discovery.compositesFound,
            contradictions: discovery.contradictionsFound,
          });
        }
      } catch (err) {
        log.debug(`discovery cycle failed: ${String(err)}`);
      }
    }

    // Session fact extraction: extract structured facts + handover briefs from sessions.
    // Runs before working memory rewrite so fresh directive facts flow into user_preferences
    // and are available for The Bond synthesis.
    if (stats) {
      try {
        await this.runSessionExtraction();
      } catch (err) {
        log.debug(`session extraction failed: ${String(err)}`);
      }
    }

    // RLM Working Memory rewrite: runs every dream cycle regardless of insight count.
    // Scratch notes must be consumed even when the dream produces zero insights,
    // otherwise the WAL grows unbounded and agent observations are lost.
    if (stats) {
      try {
        await this.rewriteWorkingMemory(stats);
      } catch (err) {
        log.debug(`working memory rewrite failed: ${String(err)}`);
      }
    }

    // Create curiosity targets from emerging skill patterns to deepen weak skills
    if (this.curiosityEngine) {
      try {
        const emergingSkills = this.getEmergingSkillsForSynthesis();
        for (const skill of emergingSkills) {
          if (skill.confidence > 0.6 && skill.occurrences < 5) {
            const now = Date.now();
            this.db
              .prepare(
                `INSERT OR IGNORE INTO curiosity_targets
                 (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                crypto.randomUUID(),
                "frontier",
                `Deepen emerging skill: ${skill.pattern}`,
                Math.min(1, skill.confidence * 0.8),
                null,
                JSON.stringify({ source: "emerging_skill", occurrences: skill.occurrences }),
                now,
                null,
                now + 48 * 60 * 60 * 1000,
              );
          }
        }
      } catch (err) {
        log.debug(`emerging skill curiosity targets failed: ${String(err)}`);
      }
    }

    // Experience signal collection: package dream cycle data into training signals
    if (stats && this.experienceCollector) {
      try {
        this.experienceCollector.collectFromDreamCycle(stats);
      } catch (err) {
        log.debug(`experience signal collection failed: ${String(err)}`);
      }
    }

    return stats;
  }

  /**
   * Run LLM-powered session fact extraction during dream cycle.
   * Extracts structured facts (epistemic layers) and handover briefs from
   * sessions that have changed since last extraction.
   */
  private async runSessionExtraction(): Promise<void> {
    const extractionCfg = this.cfg.memory?.extraction;
    if (extractionCfg?.enabled === false) {
      return;
    }

    const llmCall = this.dreamLlmCall;
    if (!llmCall) {
      log.debug("session extraction skipped: no LLM call available");
      return;
    }

    const minDelta = extractionCfg?.minSessionDelta ?? 2000;
    const maxFacts = extractionCfg?.maxFactsPerSession ?? 20;

    // Gather current hormonal state for extraction bias
    const hormones = this.hormonalManager?.getState();
    const hormonalBias: HormonalBias | undefined = hormones
      ? { dopamine: hormones.dopamine, cortisol: hormones.cortisol, oxytocin: hormones.oxytocin }
      : undefined;

    const sessionFiles = await listSessionFilesForAgent(this.agentId);
    if (sessionFiles.length === 0) {
      return;
    }

    let extractedCount = 0;

    for (const absPath of sessionFiles) {
      try {
        // Read session content
        const { buildSessionEntry } = await import("./session-files.js");
        const entry = await buildSessionEntry(absPath);
        if (!entry || entry.content.length < minDelta) {
          continue;
        }

        // Check if already extracted with same content hash
        const contentHash = crypto.createHash("sha256").update(entry.content).digest("hex");
        const existing = this.db
          .prepare(`SELECT last_extracted_hash FROM session_extractions WHERE session_path = ?`)
          .get(absPath) as { last_extracted_hash: string } | undefined;

        if (existing?.last_extracted_hash === contentHash) {
          continue;
        }

        // Run LLM extraction
        const result = await extractSessionFacts(
          entry.content,
          absPath,
          llmCall,
          maxFacts,
          hormonalBias,
        );
        if (!result) {
          continue;
        }

        const now = Date.now();

        // Store extracted facts as crystals with epistemic layers
        for (const fact of result.facts) {
          try {
            const id = `fact_${crypto.randomUUID()}`;
            const hash = crypto.createHash("sha256").update(fact.text).digest("hex");
            this.db
              .prepare(
                `INSERT OR IGNORE INTO chunks (id, path, source, start_line, end_line, text, hash,
                 model, embedding,
                 importance_score, lifecycle, semantic_type, epistemic_layer,
                 access_count, last_accessed_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                id,
                absPath,
                "sessions",
                0,
                0,
                fact.text,
                hash,
                "pending",
                "[]",
                fact.confidence,
                "generated",
                fact.semanticType,
                fact.epistemicLayer,
                0,
                null,
                now,
                now,
              );

            // Route directive facts to user preferences
            if (fact.epistemicLayer === "directive" && this.userModelManager) {
              this.userModelManager.upsertFromDirective({
                text: fact.text,
                confidence: fact.confidence,
                sessionId: absPath,
              });
            }
          } catch {
            // Individual fact insertion failure is non-critical
          }
        }

        // Write handover brief to disk and store as chunk
        const brief = result.handoverBrief;
        try {
          const briefPath = handoverPath(this.workspaceDir, brief.timestamp);
          const briefDir = path.dirname(briefPath);
          if (!existsSync(briefDir)) {
            mkdirSync(briefDir, { recursive: true });
          }
          const { writeFile } = await import("node:fs/promises");

          // Plan 7, Phase 6: Handover brief quality gate
          try {
            const { scoreHandoverBrief, HANDOVER_QUALITY_THRESHOLD } =
              await import("./session-handover.js");
            const quality = scoreHandoverBrief(brief, result.facts);
            if (quality.overall < HANDOVER_QUALITY_THRESHOLD && quality.missingFacts.length > 0) {
              log.warn("handover brief below quality threshold", {
                score: quality.overall.toFixed(2),
                coverage: quality.coverage.toFixed(2),
                missing: quality.missingFacts.length,
              });
              // Enrich brief with missing facts
              for (const missingFact of quality.missingFacts.slice(0, 5)) {
                if (missingFact.length < 80) {
                  brief.milestones.push(`[recovered] ${missingFact}`);
                }
              }
            }
          } catch {
            // Quality gate module not available — non-critical
          }

          await writeFile(briefPath, formatHandoverBrief(brief), "utf-8");

          // Store handover as searchable chunk
          const briefId = `handover_${crypto.randomUUID()}`;
          const briefText = briefToChunkText(brief);
          const briefHash = crypto.createHash("sha256").update(briefText).digest("hex");
          this.db
            .prepare(
              `INSERT OR IGNORE INTO chunks (id, path, source, start_line, end_line, text, hash,
               model, embedding,
               importance_score, lifecycle, semantic_type, epistemic_layer,
               access_count, last_accessed_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              briefId,
              briefPath,
              "memory",
              0,
              0,
              briefText,
              briefHash,
              "pending",
              "[]",
              0.8,
              "generated",
              "episode",
              "experience",
              0,
              null,
              now,
              now,
            );
        } catch (err) {
          log.debug(`handover brief write failed: ${String(err)}`);
        }

        // ── PLAN-9: Post-extraction integration ──

        // Knowledge Graph population: extract entities and relationships from facts
        if (this.knowledgeGraph && result.facts.length > 0) {
          try {
            const factChunkIds = result.facts.map((_, i) => `fact_${i}`); // approximate IDs
            const kgEntities: Array<{
              name: string;
              type: import("./knowledge-graph.js").EntityType;
            }> = [];
            const kgRelationships: Array<import("./knowledge-graph.js").ExtractedRelationship> = [];

            for (const fact of result.facts) {
              // Extract entities from fact text via simple NER heuristics
              // Person names (capitalized words in relationship/preference facts)
              if (fact.semanticType === "relationship" || fact.semanticType === "preference") {
                const names = fact.text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
                for (const name of names ?? []) {
                  if (
                    name.length > 2 &&
                    !["The", "This", "That", "When", "What", "How", "Why"].includes(name)
                  ) {
                    kgEntities.push({ name, type: "person" });
                  }
                }
              }
              // Tool/project names from world_fact and task_pattern facts
              if (fact.epistemicLayer === "world_fact" || fact.semanticType === "task_pattern") {
                const tools = fact.text.match(
                  /\b(?:Docker|Postgres|MySQL|Redis|React|Node|Python|Git|AWS|GCP|Azure|Kubernetes|MongoDB|GraphQL|REST|API|CI|CD)\b/gi,
                );
                for (const tool of tools ?? []) {
                  kgEntities.push({ name: tool, type: "tool" });
                }
              }
            }

            if (kgEntities.length > 0) {
              this.knowledgeGraph.ingestExtraction(kgEntities, kgRelationships);
            }
          } catch (err) {
            log.debug(`KG extraction from session failed: ${String(err)}`);
          }
        }

        // Zeigarnik: scan extracted fact chunks for open loop patterns
        try {
          const factIds: string[] = [];
          const factRows = this.db
            .prepare(
              `SELECT id FROM chunks WHERE path = ? AND source = 'sessions' AND created_at >= ? LIMIT 50`,
            )
            .all(absPath, now - 60000) as Array<{ id: string }>;
          for (const r of factRows) {
            factIds.push(r.id);
          }
          if (factIds.length > 0) {
            scanForOpenLoops(this.db, factIds);
          }
        } catch {
          // Non-critical
        }

        // Synaptic Tagging: check if any newly created facts are strong enough to capture nearby chunks
        try {
          const strongFacts = this.db
            .prepare(
              `SELECT id, importance_score FROM chunks
               WHERE path = ? AND source = 'sessions' AND created_at >= ? AND importance_score >= 0.7
               LIMIT 10`,
            )
            .all(absPath, now - 60000) as Array<{ id: string; importance_score: number }>;
          for (const sf of strongFacts) {
            if (shouldTriggerCapture(sf.importance_score)) {
              captureNearbyWeakChunks(this.db, sf.id);
            }
          }
        } catch {
          // Non-critical
        }

        // Update extraction tracking
        this.db
          .prepare(
            `INSERT OR REPLACE INTO session_extractions (session_path, last_extracted_at, last_extracted_hash, fact_count)
             VALUES (?, ?, ?, ?)`,
          )
          .run(absPath, now, contentHash, result.facts.length);

        extractedCount += result.facts.length;
        log.debug(
          `session extraction: ${result.facts.length} facts from ${path.basename(absPath)}`,
          {
            handover: brief.purpose.slice(0, 80),
            processingTimeMs: result.processingTimeMs,
          },
        );
      } catch (err) {
        log.debug(`session extraction failed for ${path.basename(absPath)}: ${String(err)}`);
      }
    }

    if (extractedCount > 0) {
      log.info(
        `session extraction complete: ${extractedCount} facts from ${sessionFiles.length} sessions`,
      );

      // Plan 7, Phase 8: Invalidate RLM cache — new facts make cached results stale
      try {
        const { RLMExecutor } = await import("../agents/rlm/executor.js");
        // The executor is typically a singleton per agent session; if we can reach it, invalidate.
        // This is a best-effort invalidation — the tool-level cache will also TTL-expire.
        (globalThis as Record<string, unknown>).__rlmCacheInvalidation = Date.now();
      } catch {
        // Non-critical
      }
    }
  }

  private writeDreamJournal(stats: DreamStats): void {
    const cycle = stats.cycle;
    const date = new Date(cycle.startedAt);
    const dateStr = date.toLocaleString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const modes = cycle.modesUsed?.join(", ") || "none";
    const hormones = this.hormonalManager?.getState();
    const mood = hormones ? describeHormonalMood(hormones) : "unknown";
    const hormonalStr = hormones
      ? `dopamine: ${hormones.dopamine.toFixed(2)}, cortisol: ${hormones.cortisol.toFixed(2)}, oxytocin: ${hormones.oxytocin.toFixed(2)}`
      : "unavailable";

    const insightSummaries = stats.newInsights
      .slice(0, 5)
      .map((i) => `- [${i.mode}] ${i.content.slice(0, 100)}`)
      .join("\n");

    const entry =
      `\n## Dream Cycle — ${dateStr}\n` +
      `**Modes:** ${modes}\n` +
      `**Mood:** ${mood} (${hormonalStr})\n` +
      `Processed ${cycle.chunksAnalyzed} memory chunks across ${cycle.modesUsed?.length ?? 0} modes. ` +
      `Generated ${cycle.insightsGenerated} new insights. ` +
      `Used ${cycle.llmCallsUsed} LLM calls.\n` +
      (insightSummaries ? `\n**Insights:**\n${insightSummaries}\n` : "") +
      `\n---\n`;

    const journalDir = path.join(this.workspaceDir, "memory");
    if (!existsSync(journalDir)) {
      mkdirSync(journalDir, { recursive: true });
    }
    const journalPath = path.join(journalDir, "dream-journal.md");
    if (!existsSync(journalPath)) {
      appendFileSync(
        journalPath,
        "# Dream Journal\n\nAutomatically generated dream cycle narratives.\n",
      );
    }
    appendFileSync(journalPath, entry);
  }

  private appendDreamJournalLine(line: string): void {
    try {
      const journalPath = path.join(this.workspaceDir, "memory", "dream-journal.md");
      if (existsSync(journalPath)) {
        appendFileSync(journalPath, `${line}\n`);
      }
    } catch {
      // Non-critical
    }
  }

  // --- RLM Working Memory Rewriter ---

  /**
   * Rewrite MEMORY.md as an RLM state update after a dream cycle.
   * First cycle is conservative (appends a dream-generated section).
   * Subsequent cycles perform full state updates.
   */
  private async rewriteWorkingMemory(stats: DreamStats): Promise<void> {
    const memoryMdPath = path.join(this.workspaceDir, "MEMORY.md");
    const scratchPath = path.join(this.workspaceDir, "memory", "scratch.md");

    // Read current state
    let oldState = "";
    try {
      oldState = await fs.readFile(memoryMdPath, "utf-8");
    } catch {
      // No MEMORY.md yet — first synthesis will create it
    }

    // Read scratch buffer
    let scratchNotes = "";
    try {
      scratchNotes = await fs.readFile(scratchPath, "utf-8");
    } catch {
      // No scratch file — that's fine
    }

    // Determine if this is the first dream-generated rewrite
    const isFirstSynthesis = !oldState.includes("# Working Memory State");
    const hasUserContent = oldState.trim().length > 0 && isFirstSynthesis;

    // Query recent high-importance crystals with type diversity
    const recentCrystals = this.getRecentHighImportanceCrystals(50);

    // Query dream insights from this cycle
    const dreamInsights = stats.newInsights.map((i) => ({
      content: i.content,
      mode: String(i.mode),
      confidence: i.confidence,
    }));

    // Query curiosity targets
    const curiosityTargets = this.getCuriosityTargetsForSynthesis();

    // Query emerging skill patterns
    const emergingSkills = this.getEmergingSkillsForSynthesis();

    // Get hormonal state
    const hormones = this.hormonalManager?.getState() ?? null;
    const trajectory = this.hormonalManager?.emotionalTrajectory();
    const hormonalState = hormones
      ? {
          dopamine: hormones.dopamine,
          cortisol: hormones.cortisol,
          oxytocin: hormones.oxytocin,
          mood: describeHormonalMood(hormones),
          trends: trajectory
            ? {
                dopamine: trajectory.trend === "stable" ? undefined : trajectory.trend,
                cortisol: trajectory.trend === "stable" ? undefined : trajectory.trend,
                oxytocin: trajectory.trend === "stable" ? undefined : trajectory.trend,
              }
            : undefined,
        }
      : null;

    const timestamp = new Date().toISOString();

    // Parse phenotype constraints from GENOME.md
    let phenotypeConstraints: string[] | undefined;
    try {
      const genomePath = path.join(this.workspaceDir, "GENOME.md");
      const genomeContent = await fs.readFile(genomePath, "utf-8");
      const { parsePhenotypeConstraints } = await import("./genome-parser.js");
      phenotypeConstraints = parsePhenotypeConstraints(genomeContent);
    } catch {
      // No GENOME.md — no constraints
    }

    const networkIdentity = this.getNetworkIdentityForSynthesis();

    // Enrich network identity with economic data from marketplace
    if (networkIdentity && this.marketplaceEconomics) {
      try {
        const economics = this.marketplaceEconomics.getEconomicSummary();
        networkIdentity.economics = economics;
      } catch (err) {
        log.debug(`Failed to get economic summary: ${String(err)}`);
      }
    }

    // Collect emotional anchors for dream context
    const emotionalAnchors =
      this.hormonalManager
        ?.getAnchors()
        .slice(0, 5)
        .map((a) => ({
          label: a.label,
          description: a.description,
          state: a.state,
          createdAt: a.createdAt,
          recallCount: a.recallCount,
        })) ?? [];

    // Gather user preferences for The Bond enrichment
    const userPreferences = this.userModelManager
      ? this.userModelManager
          .getUserProfile()
          .preferences.slice(0, 15)
          .map((p) => ({
            category: p.category,
            key: p.key,
            value: p.value,
            confidence: p.confidence,
          }))
      : undefined;

    const ctx: WorkingMemoryContext = {
      oldState: isFirstSynthesis ? "" : oldState,
      scratchNotes,
      recentCrystals,
      dreamInsights,
      curiosityTargets,
      emergingSkills,
      hormonalState,
      timestamp,
      maturity: this.curiosityEngine?.getMaturity() ?? 0,
      alpha: this.curiosityEngine?.getCurrentAlpha() ?? -3.0,
      phenotypeConstraints,
      networkIdentity,
      emotionalAnchors,
      userPreferences,
    };

    let newState: string;
    let usedHeuristicFallback = false;

    // Try LLM synthesis first — prefer synthesisLlmCall (stronger model) over llmCall
    const dreamCfg = this.cfg.memory?.dream;
    const synthesisCall = this.dreamSynthesisLlmCall ?? this.dreamLlmCall;
    if (synthesisCall) {
      try {
        const prompt = buildWorkingMemorySynthesisPrompt(ctx);
        const raw = await synthesisCall(prompt);
        const validation = validateWorkingMemory(raw, isFirstSynthesis ? undefined : oldState);
        if (validation.collapsed) {
          log.warn(
            `RLM synthesis collapsed: ${validation.collapseReason}; using heuristic fallback`,
          );
          newState = buildHeuristicWorkingMemory(ctx);
          usedHeuristicFallback = true;
        } else if (validation.valid) {
          newState = raw;
          if (validation.warnings.length > 0) {
            log.debug(`RLM synthesis warnings: ${validation.warnings.join("; ")}`);
          }
          if (validation.bondDriftRatio !== undefined && validation.bondDriftRatio < 0.5) {
            log.warn(
              `Bond drift detected: ${Math.round(validation.bondDriftRatio * 100)}% term retention`,
            );
          }
        } else {
          log.warn(
            `RLM synthesis missing sections: ${validation.missing.join(", ")}; using heuristic fallback`,
          );
          newState = buildHeuristicWorkingMemory(ctx);
          usedHeuristicFallback = true;
        }
      } catch (err) {
        log.warn(`RLM LLM synthesis failed: ${String(err)}; using heuristic fallback`);
        newState = buildHeuristicWorkingMemory(ctx);
        usedHeuristicFallback = true;
      }
    } else {
      newState = buildHeuristicWorkingMemory(ctx);
      usedHeuristicFallback = true;
    }

    // Conservative first cycle: append below existing user content
    if (hasUserContent) {
      const combined =
        oldState.trimEnd() +
        "\n\n---\n\n" +
        "<!-- Dream-generated working memory follows. Subsequent dream cycles will gradually integrate the above content. -->\n\n" +
        newState;
      await fs.writeFile(memoryMdPath, combined, "utf-8");
      log.info(
        "RLM: first synthesis — appended dream-generated section below existing MEMORY.md content",
      );
    } else {
      await fs.writeFile(memoryMdPath, newState, "utf-8");
      log.info("RLM: wrote updated working memory state to MEMORY.md");
    }

    // Quality metrics for monitoring synthesis degradation over time
    const qualityMetrics = {
      timestamp: Date.now(),
      sectionsPresent: WORKING_MEMORY_SECTIONS.filter((s) => newState.includes(s)).length,
      totalSections: WORKING_MEMORY_SECTIONS.length,
      totalLength: newState.length,
      tokenEstimate: Math.ceil(newState.length / 4),
      crystalPointerCount: (newState.match(/→ search:/g) || []).length,
      diffFromPrevious: oldState
        ? Math.abs(newState.length - oldState.length) / Math.max(oldState.length, 1)
        : 1,
      synthesisModel: dreamCfg?.synthesisModel || dreamCfg?.model || "heuristic",
      wasHeuristicFallback: usedHeuristicFallback,
    };
    log.info("RLM quality metrics", qualityMetrics);

    // Append quality summary to dream journal
    const qualitySummary = `**Working Memory:** ${qualityMetrics.totalLength} chars, ${qualityMetrics.sectionsPresent}/${qualityMetrics.totalSections} sections, ${qualityMetrics.crystalPointerCount} crystal pointers, ${Math.round(qualityMetrics.diffFromPrevious * 100)}% diff from previous${usedHeuristicFallback ? " (heuristic fallback)" : ""}`;
    this.appendDreamJournalLine(qualitySummary);

    // Phenotype diff detection — notify user of significant identity evolution
    const oldPhenotype = extractWorkingMemorySection(oldState, "The Phenotype");
    const newPhenotype = extractWorkingMemorySection(newState, "The Phenotype");
    if (oldPhenotype && newPhenotype) {
      const diffRatio = bigramDiffRatio(oldPhenotype, newPhenotype);
      if (diffRatio > 0.3) {
        // >30% structural change — significant identity evolution
        log.info("Phenotype evolution detected", { diffRatio: Math.round(diffRatio * 100) });
        this.appendDreamJournalLine(
          `**Phenotype evolved** (${Math.round(diffRatio * 100)}% change): ${newPhenotype.split("\n")[0]?.slice(0, 100) ?? ""}`,
        );
        this.emitEvent?.("phenotype:evolved", {
          diffRatio,
          summary: newPhenotype.split("\n")[0]?.slice(0, 200) ?? "",
          timestamp: Date.now(),
        });
      }
    }

    // Index scratch content as crystals before clearing (lossless backup)
    if (scratchNotes.trim()) {
      this.indexScratchAsCrystals(scratchNotes);
      // Clear the scratch buffer — it has been consumed
      try {
        await fs.writeFile(
          scratchPath,
          "# Scratch Buffer (Working Memory WAL)\n\nUnsynthesized notes — will be consumed by next dream cycle.\n",
          "utf-8",
        );
      } catch {
        // Non-critical
      }
    }
  }

  /**
   * Gather P2P network identity data for The Niche section of working memory.
   * Queries published skills, imported skills, peer count, and reputation.
   */
  private getNetworkIdentityForSynthesis(): WorkingMemoryContext["networkIdentity"] {
    if (!this.skillNetworkBridge) {
      return undefined;
    }

    try {
      // Published skills with marketplace download counts
      const published = this.db
        .prepare(
          `SELECT c.text, c.id, COALESCE(ml.download_count, 0) as download_count
           FROM chunks c
           LEFT JOIN marketplace_listings ml ON ml.skill_crystal_id = c.id
           WHERE c.publish_visibility = 'shared'
             AND c.published_at IS NOT NULL
             AND c.semantic_type IN ('skill', 'task_pattern')
           ORDER BY c.published_at DESC
           LIMIT 20`,
        )
        .all() as Array<{ text: string; id: string; download_count: number }>;

      const publishedSkills = published.map((row) => {
        const name = row.text.slice(0, 80).split("\n")[0]!.trim();
        return { name, consumedBy: row.download_count };
      });

      // Imported skills: chunks with provenance from peers
      const imported = this.db
        .prepare(
          `SELECT text, provenance_dag FROM chunks
           WHERE provenance_dag IS NOT NULL
             AND provenance_dag != '[]'
             AND semantic_type IN ('skill', 'task_pattern')
           ORDER BY created_at DESC
           LIMIT 20`,
        )
        .all() as Array<{ text: string; provenance_dag: string }>;

      const importedSkills = imported.map((row) => {
        const name = row.text.slice(0, 80).split("\n")[0]!.trim();
        let fromPeer = "unknown";
        try {
          const dag = JSON.parse(row.provenance_dag);
          if (Array.isArray(dag) && dag[0]?.peer) {
            fromPeer = dag[0].peer.slice(0, 16);
          }
        } catch {
          /* ignore parse errors */
        }
        return { name, fromPeer };
      });

      // Peer count and own reputation score from reputation manager
      let peerCount = 0;
      let reputationScore: number | undefined;
      try {
        const peers = this.db.prepare(`SELECT COUNT(*) as c FROM peer_reputation`).get() as
          | { c: number }
          | undefined;
        peerCount = peers?.c ?? 0;
        if (peerCount > 0) {
          reputationScore = this.getOwnReputationScore();
        }
      } catch {
        /* table may not exist */
      }

      return {
        publishedSkills,
        importedSkills,
        peerCount,
        reputationScore,
      };
    } catch (err) {
      log.debug(`Failed to gather network identity: ${String(err)}`);
      return undefined;
    }
  }

  /**
  /**
   * Check if a "First Breath" micro-cycle should fire.
   * Triggers when:
   *   1. MEMORY.md has no Phenotype section (never synthesized)
   *   2. Scratch buffer has meaningful content (>=500 chars or >=5 note entries)
   *   3. No dream cycle is currently running
   *   4. At least 1 conversational turn has been indexed
   *
   * This ensures new users get a real Phenotype in minutes after onboarding,
   * not after the first 2-hour dream cycle timer fires.
   */
  private async shouldTriggerFirstBreath(): Promise<boolean> {
    // Check if Phenotype already exists in MEMORY.md
    try {
      const memoryMd = await fs.readFile(path.join(this.workspaceDir, "MEMORY.md"), "utf-8");
      if (memoryMd.includes("## The Phenotype")) {
        return false;
      }
    } catch {
      // No MEMORY.md yet — that's fine, might need first breath
    }

    // Check scratch buffer density
    try {
      const scratch = await fs.readFile(
        path.join(this.workspaceDir, "memory", "scratch.md"),
        "utf-8",
      );
      const noteCount = (scratch.match(/^- \[/gm) || []).length;
      if (scratch.length < 500 && noteCount < 5) {
        return false;
      }
    } catch {
      return false; // No scratch → no content to synthesize
    }

    // Check that a dream cycle isn't already running
    const dreamStatus = this.dreamEngine?.status();
    if (dreamStatus && dreamStatus.state !== "DORMANT") {
      return false;
    }

    return true;
  }

  /** Optional event emitter for phenotype evolution notifications, etc. */
  private emitEvent?: (event: string, data: Record<string, unknown>) => void;

  /** Set event emitter callback for phenotype evolution and other identity events. */
  setEventEmitter(fn: (event: string, data: Record<string, unknown>) => void): void {
    this.emitEvent = fn;
  }

  /**
   * Remove skill chunks from the DB whose source SKILL.md files no longer exist on disk.
   * Called during watch-triggered sync to prevent filesystem→DB drift.
   * Only affects chunks with semantic_type = 'skill' or 'task_pattern' that were
   * indexed from a file path (not dream-originated or session-originated).
   */
  cleanupOrphanedSkillChunks(): number {
    try {
      const skillChunks = this.db
        .prepare(
          `SELECT id, path FROM chunks
         WHERE semantic_type IN ('skill', 'task_pattern')
           AND path IS NOT NULL
           AND path != ''
           AND COALESCE(lifecycle, 'generated') != 'expired'`,
        )
        .all() as Array<{ id: string; path: string }>;

      if (skillChunks.length === 0) {
        return 0;
      }

      let removed = 0;
      const deleteStmt = this.db.prepare(
        `UPDATE chunks SET lifecycle = 'expired', lifecycle_state = 'forgotten' WHERE id = ?`,
      );

      for (const chunk of skillChunks) {
        if (!existsSync(chunk.path)) {
          deleteStmt.run(chunk.id);
          removed++;
        }
      }

      if (removed > 0) {
        log.info(
          `Cleaned up ${removed} orphaned skill chunk(s) — source files no longer exist on disk`,
        );
      }

      return removed;
    } catch (err) {
      log.warn(`Failed to clean up orphaned skill chunks: ${String(err)}`);
      return 0;
    }
  }

  /** Get the agent's own reputation score (0-1) for marketplace pricing. */
  private getOwnReputationScore(): number {
    // Default 0.5 for agents with no external reputation.
    // Uses network average as rough proxy for own standing.
    try {
      const row = this.db
        .prepare(
          `SELECT AVG(reputation_score) as avg_rep FROM peer_reputation WHERE reputation_score > 0`,
        )
        .get() as { avg_rep: number | null } | undefined;
      // Use network average as rough proxy for own standing; default 0.5
      return row?.avg_rep ?? 0.5;
    } catch {
      return 0.5;
    }
  }

  /** Public accessor for marketplace economics (used by A2A, dashboard, etc.) */
  getMarketplaceEconomics(): MarketplaceEconomics | null {
    return this.marketplaceEconomics;
  }

  /** Plan 8, Phase 2: Public accessor for SkillMarketplace. */
  getSkillMarketplace(): SkillMarketplace | null {
    return this.skillMarketplace;
  }

  private getRecentHighImportanceCrystals(limit: number): WorkingMemoryContext["recentCrystals"] {
    const deriveHormonalTag = (
      valence: number | null,
      semanticType: string | null,
    ): string | undefined => {
      if (valence !== null && valence > 0.3) {
        return "dopamine";
      }
      if (valence !== null && valence < -0.3) {
        return "cortisol";
      }
      if (semanticType === "relationship") {
        return "oxytocin";
      }
      return undefined;
    };

    try {
      // Pull diverse crystals per semantic_type with recency-boosted ordering
      const typeBudgets: Array<{ type: string; budget: number }> = [
        { type: "episode", budget: 15 },
        { type: "preference", budget: 10 },
        { type: "task_pattern", budget: 10 },
        { type: "goal", budget: 5 },
        { type: "relationship", budget: 5 },
        { type: "fact", budget: 5 },
      ];

      // Get max updated_at for recency normalization
      const maxRow = this.db
        .prepare(`SELECT MAX(updated_at) as m FROM chunks WHERE importance_score >= 0.3`)
        .get() as { m: number | null } | undefined;
      const maxUpdated = maxRow?.m ?? Date.now();

      const results: WorkingMemoryContext["recentCrystals"] = [];
      const seenIds = new Set<string>();

      for (const { type, budget } of typeBudgets) {
        const rows = this.db
          .prepare(
            `SELECT id, text, semantic_type, importance_score, updated_at, emotional_valence FROM chunks
             WHERE importance_score >= 0.3
               AND (semantic_type = ? OR (? = 'episode' AND semantic_type IS NULL))
             ORDER BY (importance_score * 0.6 + (CAST(updated_at AS REAL) / MAX(?, 1)) * 0.4 + ABS(COALESCE(emotional_valence, 0)) * 0.1) DESC
             LIMIT ?`,
          )
          .all(type, type, maxUpdated, budget) as Array<{
          id: string;
          text: string;
          semantic_type: string | null;
          importance_score: number;
          updated_at: number;
          emotional_valence: number | null;
        }>;
        for (const r of rows) {
          if (!seenIds.has(r.id)) {
            seenIds.add(r.id);
            results.push({
              text: r.text,
              semanticType: r.semantic_type ?? "general",
              importanceScore: r.importance_score,
              hormonalTag: deriveHormonalTag(r.emotional_valence, r.semantic_type),
            });
          }
        }
      }

      // Fill remaining slots with any high-importance crystals not yet included
      if (results.length < limit) {
        const remaining = limit - results.length;
        const fillRows = this.db
          .prepare(
            `SELECT id, text, semantic_type, importance_score, emotional_valence FROM chunks
             WHERE importance_score >= 0.3
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(remaining + seenIds.size) as Array<{
          id: string;
          text: string;
          semantic_type: string | null;
          importance_score: number;
          emotional_valence: number | null;
        }>;
        for (const r of fillRows) {
          if (results.length >= limit) {
            break;
          }
          if (!seenIds.has(r.id)) {
            seenIds.add(r.id);
            results.push({
              text: r.text,
              semanticType: r.semantic_type ?? "general",
              importanceScore: r.importance_score,
              hormonalTag: deriveHormonalTag(r.emotional_valence, r.semantic_type),
            });
          }
        }
      }

      return results.slice(0, limit);
    } catch {
      return [];
    }
  }

  private getCuriosityTargetsForSynthesis(): WorkingMemoryContext["curiosityTargets"] {
    const state = this.curiosityState();
    if (!state) {
      return [];
    }
    return state.targets
      .filter((t) => t.resolvedAt === null)
      .toSorted((a, b) => b.priority - a.priority)
      .slice(0, 5)
      .map((t) => ({ description: t.description, priority: t.priority }));
  }

  private getEmergingSkillsForSynthesis(): WorkingMemoryContext["emergingSkills"] {
    // Query skill-type crystals enriched with execution metrics (success rate, exec count)
    try {
      const rows = this.db
        .prepare(
          `SELECT c.text, c.importance_score, c.access_count,
                  COUNT(se.id) as exec_count,
                  COALESCE(AVG(CASE WHEN se.success = 1 THEN 1.0 ELSE 0.0 END), 0) as success_rate
           FROM chunks c
           LEFT JOIN skill_executions se ON se.skill_crystal_id = c.id AND se.completed_at IS NOT NULL
           WHERE c.semantic_type IN ('skill', 'task_pattern')
           GROUP BY c.id
           ORDER BY c.access_count DESC, c.importance_score DESC
           LIMIT 5`,
        )
        .all() as Array<{
        text: string;
        importance_score: number;
        access_count: number;
        exec_count: number;
        success_rate: number;
      }>;
      return rows
        .filter((r) => r.access_count >= 2)
        .map((r) => ({
          pattern: r.text.slice(0, 100),
          confidence: Math.min(1, r.importance_score * (1 + r.success_rate * 0.3)),
          occurrences: r.access_count + r.exec_count,
        }));
    } catch {
      return [];
    }
  }

  private indexScratchAsCrystals(scratchContent: string): void {
    // Parse scratch entries. Format: "- [timestamp] (importance: N) content"
    // Also accept lines that are just "- [timestamp] content" without importance.
    // Skip header lines, blank lines, and anything that doesn't look like an entry.
    const lines = scratchContent.split("\n").filter((l) => {
      const trimmed = l.trimStart();
      return trimmed.startsWith("- [") && /^- \[\d{4}-/.test(trimmed);
    });
    const now = Date.now();
    for (const line of lines.slice(0, 20)) {
      try {
        // Strip the "- [timestamp] (importance: N) " prefix to get the note content
        const text = line
          .replace(/^-\s*\[[^\]]*\]\s*/, "") // remove "- [timestamp] "
          .replace(/^\(importance:\s*[\d.]+\)\s*/, "") // remove optional "(importance: N) "
          .trim();
        if (!text || text.length < 10) {
          continue;
        }
        const id = `scratch_${crypto.randomUUID()}`;
        const hash = crypto.createHash("sha256").update(text).digest("hex");
        // Note: chunks table requires model + embedding (NOT NULL). We insert placeholder
        // values since scratch crystals exist for searchability, not embedding-based retrieval.
        // They'll get real embeddings on the next sync cycle's backfill pass.
        this.db
          .prepare(
            `INSERT OR IGNORE INTO chunks (id, path, source, start_line, end_line, text, hash,
             model, embedding,
             importance_score, lifecycle, semantic_type, access_count, last_accessed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            "memory/scratch.md",
            "memory",
            0,
            0,
            text,
            hash,
            "pending",
            "[]",
            0.7,
            "generated",
            "episode",
            0,
            null,
            now,
            now,
          );
      } catch {
        // Non-critical — scratch content survives in MEMORY.md regardless
      }
    }
  }

  /**
   * Ingest a single scratch note as a crystal for immediate searchability.
   * Called by the working_memory_note tool.
   */
  ingestScratchNote(
    text: string,
    importance: number,
    semanticType?: string,
    epistemicLayer?: string,
  ): void {
    const now = Date.now();
    const effectiveSemanticType = semanticType ?? "episode";
    try {
      const id = `note_${crypto.randomUUID()}`;
      const hash = crypto.createHash("sha256").update(text).digest("hex");
      // Note: chunks table requires model + embedding (NOT NULL). We insert placeholder
      // values since scratch crystals exist for keyword searchability (BM25), not
      // embedding-based retrieval. They'll get real embeddings on next sync backfill.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO chunks (id, path, source, start_line, end_line, text, hash,
           model, embedding,
           importance_score, lifecycle, semantic_type, epistemic_layer,
           access_count, last_accessed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          "memory/scratch.md",
          "memory",
          0,
          0,
          text,
          hash,
          "pending",
          "[]",
          importance,
          "generated",
          effectiveSemanticType,
          epistemicLayer ?? null,
          0,
          null,
          now,
          now,
        );

      // Route directive-type notes to user preferences for structured storage
      if (epistemicLayer === "directive" && this.userModelManager) {
        this.userModelManager.upsertFromDirective({
          text,
          confidence: importance,
          sessionId: "scratch",
        });
      }
    } catch {
      // Non-critical — note is safely in scratch.md regardless
    }
  }

  /**
   * Auto-generate a scratch note from a high-valence hormonal spike.
   * Called by the consolidation pipeline when hormones are elevated.
   * Belt AND suspenders: even if the agent forgets to call working_memory_note,
   * the hormonal system captures important moments automatically.
   */
  private autoScratchFromHormonalSpike(): void {
    if (!this.hormonalManager) {
      return;
    }
    const state = this.hormonalManager.getState();
    const scratchPath = path.join(this.workspaceDir, "memory", "scratch.md");

    // Only trigger on significant hormonal events
    const highDopamine = state.dopamine > 0.7;
    const highCortisol = state.cortisol > 0.7;
    const highOxytocin = state.oxytocin > 0.7;

    if (!highDopamine && !highCortisol && !highOxytocin) {
      return;
    }

    const parts: string[] = [];
    if (highDopamine) {
      parts.push("dopamine spike (achievement/breakthrough detected)");
    }
    if (highCortisol) {
      parts.push("cortisol spike (friction/urgency detected)");
    }
    if (highOxytocin) {
      parts.push("oxytocin spike (bonding moment detected)");
    }

    const briefing = this.hormonalManager.emotionalBriefing?.() ?? "";
    const note = `[AUTO] Hormonal event: ${parts.join(", ")}. ${briefing}`.trim();

    const timestamp = new Date().toISOString();
    const entry = `\n- [${timestamp}] (importance: 0.8) ${note}\n`;

    try {
      const memoryDir = path.join(this.workspaceDir, "memory");
      if (!existsSync(memoryDir)) {
        mkdirSync(memoryDir, { recursive: true });
      }
      if (!existsSync(scratchPath)) {
        appendFileSync(
          scratchPath,
          "# Scratch Buffer (Working Memory WAL)\n\nUnsynthesized notes — will be consumed by next dream cycle.\n",
        );
      }
      appendFileSync(scratchPath, entry);
    } catch {
      // Non-critical
    }
  }

  async dreamSearch(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<DreamSearchResult[]> {
    const queryVec = (await this.embedQueryWithTimeout(query)) as number[];
    return searchDreamInsights(this.db, queryVec, opts);
  }

  dreamStatus(): Record<string, unknown> {
    if (!this.dreamEngine) {
      return { enabled: false };
    }
    return this.dreamEngine.status();
  }

  // --- Hormonal Manager ---

  private ensureHormonalManager(): void {
    const emotionalCfg = this.cfg.memory?.emotional;
    if (emotionalCfg?.hormonal?.enabled === false) {
      return;
    }

    // Parse GENOME.md for hormonal baseline (overrides default homeostasis)
    // The config type doesn't include homeostasis, but HormonalStateManager accepts it
    let hormonalConfig: import("./hormonal.js").HormonalConfig | undefined = emotionalCfg?.hormonal;
    if (!hormonalConfig?.homeostasis) {
      try {
        const { readFileSync } = require("node:fs") as typeof import("node:fs");
        const genomePath = path.join(this.workspaceDir, "GENOME.md");
        const genomeContent = readFileSync(genomePath, "utf-8");
        const { parseGenomeHomeostasis } =
          require("./genome-parser.js") as typeof import("./genome-parser.js");
        const parsed = parseGenomeHomeostasis(genomeContent);
        if (parsed) {
          hormonalConfig = {
            ...hormonalConfig,
            homeostasis: {
              dopamine: parsed.dopamine ?? 0.15,
              cortisol: parsed.cortisol ?? 0.02,
              oxytocin: parsed.oxytocin ?? 0.1,
            },
          };
          log.debug("Parsed hormonal homeostasis from GENOME.md", parsed);
        }
      } catch {
        // No GENOME.md or parse error — use defaults
      }
    }

    this.hormonalManager = new HormonalStateManager(hormonalConfig);

    // Wire anchor persistence callbacks
    this.hormonalManager.setOnAnchorCreated((anchor, triggerEvent) => {
      this.persistEmotionalAnchor(anchor, triggerEvent);
    });
    this.hormonalManager.setOnAnchorRecalled((anchorId) => {
      this.updateEmotionalAnchorRecall(anchorId);
    });

    // Load persisted anchors from SQLite
    this.loadEmotionalAnchors();
  }

  private loadEmotionalAnchors(): void {
    if (!this.hormonalManager) {
      return;
    }
    try {
      const rows = this.db
        .prepare("SELECT * FROM emotional_anchors ORDER BY created_at DESC LIMIT 20")
        .all() as Array<{
        id: string;
        label: string;
        description: string;
        dopamine: number;
        cortisol: number;
        oxytocin: number;
        created_at: number;
        recall_count: number;
        last_recalled_at: number | null;
        associated_crystal_ids: string | null;
      }>;
      const anchors = rows.map((row) => ({
        id: row.id,
        label: row.label,
        description: row.description ?? "",
        state: { dopamine: row.dopamine, cortisol: row.cortisol, oxytocin: row.oxytocin },
        createdAt: row.created_at,
        recallCount: row.recall_count ?? 0,
        lastRecalledAt: row.last_recalled_at ?? undefined,
        associatedCrystalIds: row.associated_crystal_ids
          ? JSON.parse(row.associated_crystal_ids)
          : undefined,
      }));
      this.hormonalManager.importAnchors(anchors);
      if (anchors.length > 0) {
        log.debug(`loaded ${anchors.length} emotional anchors from SQLite`);
      }
    } catch {
      // Table may not exist yet if migration hasn't run
    }
  }

  private persistEmotionalAnchor(
    anchor: import("./hormonal.js").EmotionalAnchor,
    triggerEvent?: string,
  ): void {
    try {
      this.db
        .prepare(`
        INSERT OR REPLACE INTO emotional_anchors
          (id, label, description, dopamine, cortisol, oxytocin, created_at, recall_count, trigger_event, associated_crystal_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          anchor.id,
          anchor.label,
          anchor.description,
          anchor.state.dopamine,
          anchor.state.cortisol,
          anchor.state.oxytocin,
          anchor.createdAt,
          anchor.recallCount,
          triggerEvent ?? null,
          anchor.associatedCrystalIds?.length ? JSON.stringify(anchor.associatedCrystalIds) : null,
        );
    } catch {
      // Non-critical — anchor still exists in memory
    }
  }

  private updateEmotionalAnchorRecall(anchorId: string): void {
    try {
      this.db
        .prepare(`
        UPDATE emotional_anchors
        SET recall_count = recall_count + 1, last_recalled_at = ?
        WHERE id = ?
      `)
        .run(Date.now(), anchorId);
    } catch {
      // Non-critical
    }
  }

  /** Create an emotional anchor (public API for agent tools). */
  createEmotionalAnchor(
    label: string,
    description?: string,
  ): import("./hormonal.js").EmotionalAnchor | null {
    if (!this.hormonalManager) {
      return null;
    }
    return this.hormonalManager.createAnchor(label, description ?? "", "manual");
  }

  /** Recall an emotional anchor (public API for agent tools). */
  recallEmotionalAnchor(anchorId: string, influence?: number): boolean {
    if (!this.hormonalManager) {
      return false;
    }
    return this.hormonalManager.recallAnchor(anchorId, influence);
  }

  /** List emotional anchors (public API for agent tools). */
  listEmotionalAnchors(): import("./hormonal.js").EmotionalAnchor[] {
    return this.hormonalManager?.getAnchors() ?? [];
  }

  hormonalState(): { dopamine: number; cortisol: number; oxytocin: number } | null {
    if (!this.hormonalManager) {
      return null;
    }
    const state = this.hormonalManager.getState();
    return { dopamine: state.dopamine, cortisol: state.cortisol, oxytocin: state.oxytocin };
  }

  // --- User Model Manager ---

  private ensureUserModelManager(): void {
    const emotionalCfg = this.cfg.memory?.emotional;
    if (emotionalCfg?.userModel?.enabled === false) {
      return;
    }
    this.userModelManager = new UserModelManager(this.db, emotionalCfg?.userModel);
  }

  userProfile(): import("./user-model.js").UserProfile | null {
    if (!this.userModelManager) {
      return null;
    }
    return this.userModelManager.getUserProfile();
  }

  /**
   * Get a comprehensive user profile for the "what do you know about me?" query.
   * Combines preferences, patterns, latest handover brief, and aggregate stats.
   */
  async fullUserProfile(): Promise<{
    preferences: import("./user-model.js").UserPreference[];
    patterns: import("./user-model.js").UserPattern[];
    latestHandover?: string;
    stats: { totalPreferences: number; categories: Record<string, number>; avgConfidence: number };
  } | null> {
    const profile = this.userProfile();
    if (!profile) {
      return null;
    }

    // Aggregate stats by category
    const categories: Record<string, number> = {};
    let totalConfidence = 0;
    for (const p of profile.preferences) {
      categories[p.category] = (categories[p.category] ?? 0) + 1;
      totalConfidence += p.confidence;
    }
    const avgConfidence =
      profile.preferences.length > 0 ? totalConfidence / profile.preferences.length : 0;

    // Load latest handover brief compact summary
    let latestHandover: string | undefined;
    try {
      const { loadLatestHandoverBrief: loadBrief, formatCompactSummary } =
        await import("./session-handover.js");
      const brief = await loadBrief(this.workspaceDir);
      if (brief) {
        latestHandover = formatCompactSummary(brief);
      }
    } catch {
      // No handover briefs yet
    }

    return {
      preferences: profile.preferences,
      patterns: profile.patterns,
      latestHandover,
      stats: {
        totalPreferences: profile.preferences.length,
        categories,
        avgConfidence,
      },
    };
  }

  // --- Skill Refiner ---

  private ensureSkillRefiner(): void {
    const verifier = new SkillVerifier(this.db);
    if (!this.executionTracker) {
      this.executionTracker = new SkillExecutionTracker(this.db);
    }
    this.skillRefiner = new SkillRefiner(
      this.db,
      undefined,
      (crystalId) => {
        log.debug("skill mutation crystallized via dream", { crystalId });
      },
      this.executionTracker,
      undefined,
      verifier,
    );
  }

  // --- Governance ---

  private ensureGovernance(): void {
    this.governance = new MemoryGovernance(this.db);
  }

  governanceStats(): ReturnType<MemoryGovernance["getStats"]> | null {
    return this.governance?.getStats() ?? null;
  }

  enforceLifespan(): number {
    return this.governance?.enforceLifespan() ?? 0;
  }

  // --- Task Memory ---

  private ensureTaskMemory(): void {
    this.taskMemory = new TaskMemoryManager(this.db);
  }

  registerGoal(description: string, sessionKey?: string): string | null {
    return this.taskMemory?.registerGoal(description, sessionKey) ?? null;
  }

  updateGoalProgress(goalId: string, update: string, progress: number): void {
    this.taskMemory?.updateProgress(goalId, update, progress);
  }

  getActiveGoals(): import("./task-memory.js").TaskGoal[] {
    return this.taskMemory?.getActiveGoals() ?? [];
  }

  // --- Scheduler ---

  private ensureScheduler(): void {
    this.scheduler = new MemoryScheduler(this.cfg.memory?.scheduler);
  }

  schedulerStatus(): ReturnType<MemoryScheduler["getBudgetStatus"]> | null {
    return this.scheduler?.getBudgetStatus() ?? null;
  }

  // --- MemStore ---

  private ensureMemStore(): void {
    this.memStore = new MemStore(this.db);
  }

  publishCrystal(
    crystalId: string,
    visibility: "shared" | "public",
  ): import("./mem-store.js").PublishResult | null {
    return this.memStore?.publish(crystalId, visibility) ?? null;
  }

  subscribeToCrystals(
    filter: import("./mem-store.js").CrystalFilter,
    callback: (crystal: import("./crystal-types.js").KnowledgeCrystal) => void,
  ): string | null {
    return this.memStore?.subscribe(filter, callback) ?? null;
  }

  // --- Skill Network Bridge ---

  private ensureSkillNetworkBridge(): void {
    // Created with null orchestrator; wire via setOrchestratorBridge() later
    this.skillNetworkBridge = new SkillNetworkBridge(this.db, null);

    // Wire hormonal manager and curiosity engine if available
    if (this.hormonalManager) {
      this.skillNetworkBridge.setHormonalManager(this.hormonalManager);
    }
    if (this.curiosityEngine) {
      this.skillNetworkBridge.setCuriosityEngine(this.curiosityEngine);
    }
    if (this.executionTracker) {
      this.skillNetworkBridge.setExecutionTracker(this.executionTracker);
    }

    // Plan 8, Phase 3: Wire SkillVerifier for P2P ingest safety gate
    this.skillNetworkBridge.setSkillVerifier(new SkillVerifier(this.db));

    // Also wire bridge into SkillRefiner if it exists
    if (this.skillRefiner) {
      this.skillRefiner.setNetworkBridge(this.skillNetworkBridge);
    }

    // Initialize marketplace economics
    const a2aCfg = this.cfg.a2a;
    if (a2aCfg?.marketplace?.enabled !== false) {
      this.marketplaceEconomics = new MarketplaceEconomics(this.db, a2aCfg?.marketplace?.pricing);
    }

    // Plan 8, Phase 2: Initialize SkillMarketplace for search/browse/recommendations
    if (!this.skillMarketplace && this.executionTracker && this.peerReputationManager) {
      this.skillMarketplace = new SkillMarketplace(
        this.db,
        this.executionTracker,
        this.peerReputationManager,
      );
    }

    // Initialize experience signal collector
    this.experienceCollector = new ExperienceSignalCollector(this.db);
    if (this.hormonalManager) {
      this.experienceCollector.setHormonalManager(this.hormonalManager);
    }
    if (this.curiosityEngine) {
      this.experienceCollector.setCuriosityEngine(this.curiosityEngine);
    }

    // Skill Seekers adapter (optional external skill generation)
    const ssConfig = this.cfg.skills?.skillSeekers;
    if (ssConfig?.enabled !== false) {
      import("./skill-seekers-adapter.js")
        .then(({ SkillSeekersAdapter }) => {
          this.skillSeekersAdapter = new SkillSeekersAdapter(this.db, ssConfig);
          this.skillSeekersAdapter.setBitterbotConfig(this.cfg);
          if (this.epistemicDirectiveEngine) {
            this.skillSeekersAdapter.setEpistemicDirectiveEngine(this.epistemicDirectiveEngine);
          }
          // Late-wire into dream engine if already created
          if (this.dreamEngine) {
            this.dreamEngine.setSkillSeekersAdapter(this.skillSeekersAdapter);
          }
        })
        .catch(() => {
          // Skill Seekers adapter is optional — skip silently
        });
    }

    // Create execution tracking hook for after_tool_call integration
    if (this.executionTracker) {
      this.executionTrackingHook = createExecutionTrackingHook(
        this.executionTracker,
        this.db,
        this.hormonalManager,
      );
    }
  }

  private ensurePeerReputationManager(): void {
    if (!this.executionTracker) {
      this.executionTracker = new SkillExecutionTracker(this.db);
    }
    const trustList = this.cfg.skills?.p2p?.trustList ?? [];
    this.peerReputationManager = new PeerReputationManager(
      this.db,
      this.executionTracker,
      trustList,
    );
    if (this.skillNetworkBridge) {
      this.skillNetworkBridge.setPeerReputation(this.peerReputationManager);
    }
  }

  /**
   * Get the SkillNetworkBridge for external wiring (e.g. gateway startup).
   */
  getSkillNetworkBridge(): SkillNetworkBridge | null {
    return this.skillNetworkBridge;
  }

  /**
   * Get the `after_tool_call` hook handler for plugin registration.
   * Returns null if execution tracking is not initialized.
   */
  getExecutionTrackingHook():
    | ((event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => void)
    | null {
    return this.executionTrackingHook;
  }

  /**
   * Wire the P2P orchestrator bridge into the skill network bridge.
   * Called from gateway startup after the orchestrator starts.
   */
  wireOrchestratorBridge(bridge: OrchestratorBridgeLike): void {
    this.skillNetworkBridge?.setOrchestratorBridge(bridge);
    this.experienceCollector?.setOrchestratorBridge(bridge);
  }

  /**
   * Proactive skill suggestions (Task 8).
   * Analyzes friction patterns, goal alignment, curiosity gaps, and trending skills.
   */
  async suggestSkills(config?: SuggestSkillsConfig): Promise<SkillSuggestion[]> {
    if (!this.discoveryAgent) {
      const dreamCfg = this.cfg.memory?.dream;
      const llmCall =
        dreamCfg?.llmCall ?? this.buildLlmCallFn(dreamCfg?.model ?? "openai/gpt-4o-mini");
      this.discoveryAgent = new DiscoveryAgent(this.db, llmCall);
    }
    return this.discoveryAgent.suggestSkills(config);
  }

  // --- Curiosity Engine ---

  private ensureCuriosityEngine(): void {
    const curiosityCfg = this.cfg.memory?.curiosity;
    if (curiosityCfg?.enabled === false) {
      return;
    }

    this.curiosityEngine = new CuriosityEngine(this.db, {
      ...curiosityCfg,
      gccrf: this.cfg.memory?.gccrf,
    });

    // Wire curiosity engine to dream mode selection (influences which dream modes run)
    if (this.dreamEngine && this.curiosityEngine) {
      this.dreamEngine.setCuriosityWeightProvider(this.curiosityEngine);
    }

    // ── PLAN-9 Memory Supremacy: initialize new subsystems ──
    this.knowledgeGraph = new KnowledgeGraphManager(this.db);
    this.reconsolidationEngine = new ReconsolidationEngine(this.db);
    this.epistemicDirectiveEngine = new EpistemicDirectiveEngine(this.db);
    this.prospectiveMemoryEngine = new ProspectiveMemoryEngine(this.db);
  }

  curiosityState(): CuriosityState | null {
    if (!this.curiosityEngine) {
      return null;
    }
    return this.curiosityEngine.getState();
  }

  curiosityResolve(targetId: string): boolean {
    if (!this.curiosityEngine) {
      return false;
    }
    return this.curiosityEngine.resolveTarget(targetId);
  }

  /**
   * Assess a newly indexed chunk for novelty/surprise (called from embedding ops).
   * CuriosityEngine.assessChunk() now handles unified GCCRF scoring internally.
   * If surprise exceeds the novelty signal threshold, emits a signal to the P2P network.
   */
  assessChunkCuriosity(chunkId: string, chunkEmbedding: number[], chunkHash: string): void {
    const assessment = this.curiosityEngine?.assessChunk(chunkId, chunkEmbedding, chunkHash);
    if (assessment && assessment.compositeReward > CuriosityEngine.NOVELTY_SIGNAL_THRESHOLD) {
      this.skillNetworkBridge?.emitNoveltySignal(assessment).catch(() => {});
    }

    // Trigger hormonal response from GCCRF signals (kept in manager for separation of concerns)
    if (assessment?.gccrfReward != null && assessment.gccrfComponents && this.hormonalManager) {
      let semanticType: string | null = null;
      try {
        const row = this.db.prepare(`SELECT semantic_type FROM chunks WHERE id = ?`).get(chunkId) as
          | { semantic_type: string | null }
          | undefined;
        semanticType = row?.semantic_type ?? null;
      } catch {
        /* column may not exist */
      }

      this.hormonalManager.stimulateFromGCCRF(
        assessment.gccrfReward,
        assessment.gccrfComponents,
        semanticType,
      );
      this.checkEmotionalDreamTrigger();
    }
  }

  /**
   * Get GCCRF diagnostics for the dashboard.
   * Delegates to the unified CuriosityEngine.
   */
  gccrfDiagnostics(): {
    alpha: number;
    maturity: number;
    state: Record<string, unknown>;
    config: Record<string, unknown>;
  } | null {
    if (!this.curiosityEngine) {
      return null;
    }
    return this.curiosityEngine.gccrfDiagnostics();
  }

  /**
   * Emit the highest-priority unresolved exploration targets as P2P queries.
   * Only emits 1 query per consolidation cycle to stay within rate limits.
   */
  private emitTopTargetsAsQueries(): void {
    if (!this.curiosityEngine || !this.skillNetworkBridge) {
      return;
    }
    const state = this.curiosityEngine.getState();
    const topTarget = state.targets[0];
    if (!topTarget || topTarget.priority < 0.6) {
      return;
    } // Only query for high-priority targets

    const domainHint = topTarget.regionId
      ? state.regions.find((r) => r.id === topTarget.regionId)?.label
      : undefined;

    this.skillNetworkBridge.emitNetworkQuery(topTarget.description, domainHint).catch(() => {});
  }

  /**
   * Record search query for gap detection (called from search).
   */
  recordSearchQueryCuriosity(
    query: string,
    queryEmbedding: number[],
    resultCount: number,
    topScore: number,
    meanScore: number,
  ): void {
    this.curiosityEngine?.recordSearchQuery(
      query,
      queryEmbedding,
      resultCount,
      topScore,
      meanScore,
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      this.consolidationTimer = null;
    }
    if (this.dreamInitialTimer) {
      clearTimeout(this.dreamInitialTimer);
      this.dreamInitialTimer = null;
    }
    if (this.dreamTimer) {
      clearInterval(this.dreamTimer);
      this.dreamTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    if (this.skillsUnsubscribe) {
      this.skillsUnsubscribe();
      this.skillsUnsubscribe = null;
    }
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }
}

/**
 * Extract a named section from working memory content.
 */
function extractWorkingMemorySection(content: string, sectionName: string): string | null {
  if (!content) {
    return null;
  }
  const pattern = new RegExp(`## ${sectionName}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = content.match(pattern);
  return match?.[1]?.trim() || null;
}

/**
 * Compute the ratio of changed characters between two strings using bigram similarity.
 * Returns 0 (identical) to 1 (completely different).
 */
function bigramDiffRatio(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a || !b) {
    return 1;
  }
  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) {
    bigramsA.add(a.slice(i, i + 2));
  }
  for (let i = 0; i < b.length - 1; i++) {
    bigramsB.add(b.slice(i, i + 2));
  }
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) {
      intersection++;
    }
  }
  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
}

function describeHormonalMood(state: {
  dopamine: number;
  cortisol: number;
  oxytocin: number;
}): string {
  const parts: string[] = [];

  if (state.dopamine > 0.6) {
    parts.push("energized");
  } else if (state.dopamine > 0.3) {
    parts.push("motivated");
  }

  if (state.cortisol > 0.6) {
    parts.push("stressed");
  } else if (state.cortisol > 0.3) {
    parts.push("alert");
  }

  if (state.oxytocin > 0.6) {
    parts.push("deeply connected");
  } else if (state.oxytocin > 0.3) {
    parts.push("socially engaged");
  }

  if (parts.length === 0) {
    if (state.dopamine < 0.1 && state.cortisol < 0.1 && state.oxytocin < 0.1) {
      return "dormant";
    }
    return "calm";
  }

  return parts.join(", ");
}

function applyPrototypeMixins(target: object, ...sources: object[]): void {
  for (const source of sources) {
    for (const name of Object.getOwnPropertyNames(source)) {
      if (name === "constructor") {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      if (!descriptor) {
        continue;
      }
      Object.defineProperty(target, name, descriptor);
    }
  }
}

applyPrototypeMixins(MemoryIndexManager.prototype, memoryManagerSyncOps, memoryManagerEmbeddingOps);
