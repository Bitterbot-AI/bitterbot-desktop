import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { CrystallizationCandidate } from "../../agents/skills/types.js";
import type { BitterbotConfig } from "../../config/config.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { installSkill } from "../../agents/skills-install.js";
import { withTimeout } from "../../utils/with-timeout.js";

// Cap the orchestrator IPC (getStats/getBootstrapCensus) in skills.network so a
// slow/churning orchestrator can't make the polled RPC hang for 20s+ (observed
// on this node during P2P handshake). On timeout we return the local-only view
// (stats/bootstrapCensus stay null); both calls are already best-effort.
const SKILLS_NETWORK_IPC_TIMEOUT_MS = 3_000;
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import { importAgentskillsSkill } from "../../agents/skills/agentskills-ingest.js";
import { crystallizeSkill } from "../../agents/skills/crystallize.js";
import { appendImpactEntry } from "../../agents/skills/impact-trail.js";
import {
  acceptIncomingSkill,
  readAcceptedEnvelope,
  listIncomingSkills,
  rejectIncomingSkill,
  rejectIncomingSkillsByPeer,
} from "../../agents/skills/ingest.js";
import { bumpSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { withSkillLifecycleStore } from "../../agents/skills/skill-lifecycle-from-config.js";
import { skillManage, type SkillManageParams } from "../../agents/skills/skill-manage.js";
import { promoteStaged, rollbackStaged } from "../../agents/skills/skill-promote.js";
import { resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { scanSkillForInjection } from "../../security/skill-injection-scanner.js";
import { CONFIG_DIR } from "../../utils.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsCreateParams,
  validateSkillsInstallParams,
  validateSkillsManageParams,
  validateSkillsMetricsParams,
  validateSkillsEvolutionCorpusReviewParams,
  validateSkillsPromoteParams,
  validateSkillsPublishParams,
  validateSkillsRollbackParams,
  validateSkillsStatusParams,
  validateSkillsUpdateAgentFilterParams,
  validateSkillsUpdateParams,
  validateSkillsUpdateTrustSettingsParams,
  validateSkillsUploadAgentskillsParams,
  validateSkillsValidateParams,
} from "../protocol/index.js";
import { TtlCache } from "./ttl-cache.js";

/**
 * TTL caches for the UI-polled network read RPCs. Both do heavy synchronous
 * SQLite aggregation (and skills.network also fans out over IPC/HTTP);
 * skills.networkHistory in particular groups the whole ~30-day census history
 * table (100k+ rows) into hourly buckets, costing multiple seconds. The Control
 * UI (P2pDashboard) polls both every 30s and re-issues them on every reconnect.
 *
 * The TTL MUST exceed that 30s poll interval — otherwise every poll misses and
 * re-pays the full scan, blocking the event loop and starving the 30s WS
 * keepalive, which bounces the UI and re-triggers the poll (a self-reinforcing
 * flakiness loop). These reads are append-only/slow-moving (a growth chart, a
 * current-census snapshot), so serving a poll-cadence-stale value is fine.
 * Keep these above P2pDashboard's poll interval if that interval changes.
 */
const SKILLS_NETWORK_CACHE_KEY = "skills.network";
const skillsNetworkCache = new TtlCache<unknown>(45_000);
const skillsNetworkHistoryCache = new TtlCache<unknown>(120_000);

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = String(bin).trim();
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins].toSorted();
}

/**
 * Resolve the live peer-reputation manager off the memory manager so a manual
 * skills.incoming.accept/reject credits the peer (audit 2026-08-09, F6).
 * Best-effort: returns undefined when memory/P2P is disabled.
 */
async function resolveReputationManager(
  cfg: BitterbotConfig,
): Promise<{ recordIngestionResult(peerPubkey: string, accepted: boolean): void } | undefined> {
  try {
    const { getMemorySearchManager } = await import("../../memory/index.js");
    const agentId = resolveDefaultAgentId(cfg);
    const { manager } = await getMemorySearchManager({ cfg, agentId });
    const repManager = (manager as unknown as { peerReputationManager?: unknown } | null)
      ?.peerReputationManager as
      | { recordIngestionResult(peerPubkey: string, accepted: boolean): void }
      | undefined;
    return repManager ?? undefined;
  } catch {
    return undefined;
  }
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.status": ({ params, respond }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentIdRaw = typeof params?.agentId === "string" ? params.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
    if (agentIdRaw) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
        );
        return;
      }
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: cfg,
      eligibility: { remote: getRemoteSkillEligibility() },
    });
    respond(true, report, undefined);
  },
  "skills.bins": ({ params, respond }) => {
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDirs = listAgentWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.install": async ({ params, respond }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      timeoutMs?: number;
    };
    const cfg = loadConfig();
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.crystallize": async ({ params, respond, context }) => {
    const cfg = loadConfig();
    const candidate = params as unknown as CrystallizationCandidate;
    if (
      !candidate?.taskName ||
      typeof candidate?.rewardScore !== "number" ||
      !candidate?.description ||
      !Array.isArray(candidate?.reasoningPath) ||
      !Array.isArray(candidate?.toolCalls)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid crystallization candidate: requires taskName, description, rewardScore, reasoningPath[], toolCalls[]",
        ),
      );
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const result = await crystallizeSkill({
      candidate,
      config: cfg,
      bridge: context.orchestratorBridge,
      workspaceDir,
    });
    respond(
      result.ok,
      result,
      result.ok
        ? undefined
        : errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "crystallization failed"),
    );
  },
  "skills.network": async ({ respond, context }) => {
    // Single-flight coalescing (see TtlCache.getOrCompute): a Control-UI
    // reconnect fires a burst of identical polls in the same tick; without
    // coalescing each one misses the cache and independently re-pays the IPC
    // fan-out + SQLite aggregation, piling onto the loop at once and starving
    // the keepalive tick. Coalescing collapses the burst into one pass.
    const payload = await skillsNetworkCache.getOrCompute(SKILLS_NETWORK_CACHE_KEY, async () => {
      const cfg = loadConfig();
      const p2p = cfg.p2p;
      let stats = null;
      let bootstrapCensus = null;
      if (context.orchestratorBridge) {
        try {
          stats = await withTimeout(
            context.orchestratorBridge.getStats(),
            SKILLS_NETWORK_IPC_TIMEOUT_MS,
          );
        } catch {}
        try {
          bootstrapCensus = await withTimeout(
            context.orchestratorBridge.getBootstrapCensus(),
            SKILLS_NETWORK_IPC_TIMEOUT_MS,
          );
        } catch {}
      }
      // Local lifetime metrics from the SQLite peer_reputation table — these
      // are independent of the live swarm: they survive restarts and capture
      // every peer the node has ever met.
      const localMetrics = context.skillNetworkBridge?.getNetworkMetrics?.() ?? null;
      // Network-wide census aggregated across all fresh bootnode sources, deduped
      // by pubkey (a peer connected to several bootnodes counts once). Stable,
      // unlike the old "latest single source wins" read that flapped between
      // bootnodes' divergent local counts.
      const networkCensus = context.skillNetworkBridge?.getAggregatedNetworkCensus?.() ?? null;
      return {
        enabled: p2p?.enabled ?? false,
        topics: p2p?.topics ?? {},
        security: p2p?.security ?? {},
        stats,
        localMetrics,
        bootstrapCensus,
        networkCensus,
      };
    });
    respond(true, payload, undefined);
  },
  "skills.networkHistory": async ({ params, respond, context }) => {
    // Persisted census history: every gossipsub-received bootnode snapshot
    // is appended to network_census_history so we can render a growth-over-
    // time chart. Returns rows ordered by generated_at ascending.
    const sourcePeerId = typeof params?.sourcePeerId === "string" ? params.sourcePeerId : undefined;
    const sinceMs =
      typeof params?.sinceMs === "number" && Number.isFinite(params.sinceMs)
        ? Math.max(0, Math.floor(params.sinceMs))
        : undefined;
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.max(1, Math.min(Math.floor(params.limit), 5000))
        : undefined;
    const cacheKey = JSON.stringify({ sourcePeerId, sinceMs, limit });
    const payload = await skillsNetworkHistoryCache.getOrCompute(cacheKey, async () => {
      const rows =
        context.skillNetworkBridge?.getNetworkCensusHistory?.({ sourcePeerId, sinceMs, limit }) ??
        [];
      return { rows: rows ?? [], count: rows?.length ?? 0 };
    });
    respond(true, payload, undefined);
  },
  "skills.update": async ({ params, respond }) => {
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
    };
    const cfg = loadConfig();
    const skills = cfg.skills ? { ...cfg.skills } : {};
    const entries = skills.entries ? { ...skills.entries } : {};
    const current = entries[p.skillKey] ? { ...entries[p.skillKey] } : {};
    if (typeof p.enabled === "boolean") {
      current.enabled = p.enabled;
    }
    if (typeof p.apiKey === "string") {
      const trimmed = normalizeSecretInput(p.apiKey);
      if (trimmed) {
        current.apiKey = trimmed;
      } else {
        delete current.apiKey;
      }
    }
    if (p.env && typeof p.env === "object") {
      const nextEnv = current.env ? { ...current.env } : {};
      for (const [key, value] of Object.entries(p.env)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) {
          continue;
        }
        const trimmedVal = value.trim();
        if (!trimmedVal) {
          delete nextEnv[trimmedKey];
        } else {
          nextEnv[trimmedKey] = trimmedVal;
        }
      }
      current.env = nextEnv;
    }
    entries[p.skillKey] = current;
    skills.entries = entries;
    const nextConfig: BitterbotConfig = {
      ...cfg,
      skills,
    };
    await writeConfigFile(nextConfig);
    bumpSkillsSnapshotVersion({ reason: "manual" });
    respond(true, { ok: true, skillKey: p.skillKey, config: current }, undefined);
  },
  "skills.create": async ({ params, respond }) => {
    if (!validateSkillsCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.create params: ${formatValidationErrors(validateSkillsCreateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      content: string;
      target?: "managed" | "workspace";
      agentId?: string;
      overwrite?: boolean;
    };
    const sanitizedName = p.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64);
    if (!sanitizedName) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "name normalizes to empty after sanitization"),
      );
      return;
    }
    if (!p.content.startsWith("---")) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "SKILL.md must start with YAML frontmatter (---)"),
      );
      return;
    }
    const cfg = loadConfig();
    const target = p.target ?? "managed";
    let baseDir: string;
    if (target === "workspace") {
      const agentId = p.agentId ? normalizeAgentId(p.agentId) : resolveDefaultAgentId(cfg);
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      baseDir = path.join(workspaceDir, "skills");
    } else {
      baseDir = path.join(CONFIG_DIR, "skills");
    }
    const skillDir = path.join(baseDir, sanitizedName);
    const skillPath = path.join(skillDir, "SKILL.md");
    if (!p.overwrite) {
      try {
        await fs.access(skillPath);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `skill "${sanitizedName}" already exists at ${skillPath}; pass overwrite=true to replace`,
          ),
        );
        return;
      } catch {
        // expected: file doesn't exist
      }
    }
    try {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(skillPath, p.content, "utf-8");
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `write failed: ${String(err)}`));
      return;
    }
    // PLAN-42 Phase 0 (D-C): the editor stays direct-write by design — human
    // edits are the operator's prerogative — but every ungated write is
    // recorded in the impact trail so the skill set's history stays complete.
    await appendImpactEntry({
      source: "editor",
      action: p.overwrite ? "overwrite" : "create",
      skillName: sanitizedName,
      verdict: "ungated-human-edit",
      detail: `target=${target} via skills.create`,
    });
    bumpSkillsSnapshotVersion({ reason: "manual", changedPath: skillPath });
    respond(true, { ok: true, skillName: sanitizedName, skillPath, target }, undefined);
  },
  "skills.incoming.list": async ({ respond }) => {
    const cfg = loadConfig();
    const skills = await listIncomingSkills(cfg);
    respond(true, { skills }, undefined);
  },
  "skills.incoming.accept": async ({ params, respond, context }) => {
    const skillName = typeof params?.skillName === "string" ? params.skillName.trim() : "";
    if (!skillName) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "skillName required"));
      return;
    }
    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const reputationManager = await resolveReputationManager(cfg);
    const result = await acceptIncomingSkill({
      skillName,
      config: cfg,
      workspaceDir,
      reputationManager,
    });
    // PLAN-44 Phase 3 (audit security finding 3): a quarantined envelope is
    // NOT a memory chunk while it sits in review; the operator's accept is
    // what routes it into the skill-network bridge.
    let bridge: string | undefined;
    if (result.ok && result.skillPath && context.skillNetworkBridge) {
      const envelope = await readAcceptedEnvelope(result.skillPath);
      if (envelope) {
        try {
          bridge = context.skillNetworkBridge.ingestNetworkSkill(envelope).action;
        } catch (err) {
          bridge = `error: ${String(err)}`;
        }
      }
    }
    respond(
      result.ok,
      { ...result, ...(bridge ? { bridge } : {}) },
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.reason ?? "accept failed"),
    );
  },
  "skills.incoming.reject": async ({ params, respond }) => {
    const skillName = typeof params?.skillName === "string" ? params.skillName.trim() : "";
    if (!skillName) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "skillName required"));
      return;
    }
    const cfg = loadConfig();
    const reputationManager = await resolveReputationManager(cfg);
    const result = await rejectIncomingSkill({ skillName, config: cfg, reputationManager });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.reason ?? "reject failed"),
    );
  },
  // PLAN-13 Phase C: bulk-reject every quarantined skill from a single
  // peer. Useful when a peer turns out to be compromised and the operator
  // wants to drop everything they've staged for review in one call.
  "skills.incoming.rejectByPeer": async ({ params, respond }) => {
    const authorPeerId = typeof params?.authorPeerId === "string" ? params.authorPeerId.trim() : "";
    if (!authorPeerId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "authorPeerId required"));
      return;
    }
    const cfg = loadConfig();
    const result = await rejectIncomingSkillsByPeer({ authorPeerId, config: cfg });
    respond(
      result.ok,
      result,
      result.ok
        ? undefined
        : errorShape(
            ErrorCodes.UNAVAILABLE,
            `bulk reject partial: ${result.errored.length} errored`,
          ),
    );
  },
  "skills.import.agentskills": async ({ params, respond }) => {
    const input = typeof params?.input === "string" ? params.input.trim() : "";
    if (!input) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "input required (slug or https URL)"),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const result = await importAgentskillsSkill({
      input,
      config: cfg,
      workspaceDir,
    });
    respond(
      result.ok,
      result,
      result.ok
        ? undefined
        : errorShape(ErrorCodes.UNAVAILABLE, result.reason ?? "agentskills import failed"),
    );
  },
  // Per-skill execution telemetry. Telemetry collection is wired at gateway
  // startup (server-startup-memory.ts registers the after_tool_call hook);
  // this handler surfaces what's been recorded.
  "skills.metrics": async ({ params, respond }) => {
    if (!validateSkillsMetricsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.metrics params: ${formatValidationErrors(validateSkillsMetricsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const skillKeyRaw = typeof params?.skillKey === "string" ? params.skillKey.trim() : "";
    const { MemoryIndexManager } = await import("../../memory/manager.js");
    let manager: Awaited<ReturnType<typeof MemoryIndexManager.get>> | null = null;
    try {
      manager = await MemoryIndexManager.get({
        cfg,
        agentId: resolveDefaultAgentId(cfg),
        purpose: "status",
      });
    } catch {
      // If memory is unavailable, return an empty rollup rather than 500ing.
    }
    const tracker = manager?.getSkillExecutionTracker?.() ?? null;
    if (!tracker) {
      respond(true, { metrics: [] }, undefined);
      return;
    }
    if (skillKeyRaw) {
      const m = tracker.getMetricsForSkillKey(skillKeyRaw);
      respond(true, { metrics: [{ skillKey: skillKeyRaw, ...m }] }, undefined);
      return;
    }
    const all = tracker.getAllSkillKeyMetrics();
    respond(
      true,
      { metrics: all.map((entry) => ({ skillKey: entry.skillKey, ...entry.metrics })) },
      undefined,
    );
  },
  // Per-agent skill allowlist. Mutates `cfg.agents.list[<agentId>].skills`.
  // null means "clear allowlist" (i.e. allow all skills).
  "skills.updateAgentFilter": async ({ params, respond }) => {
    if (!validateSkillsUpdateAgentFilterParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.updateAgentFilter params: ${formatValidationErrors(validateSkillsUpdateAgentFilterParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      agentId: string;
      skills: string[] | null;
    };
    const cfg = loadConfig();
    const agentId = normalizeAgentId(p.agentId);
    const list = Array.isArray(cfg.agents?.list) ? [...cfg.agents.list] : [];
    const idx = list.findIndex((entry) => normalizeAgentId(entry.id) === agentId);
    if (idx < 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${p.agentId}" not found`),
      );
      return;
    }
    const next = { ...list[idx]! };
    if (p.skills === null) {
      delete next.skills;
    } else {
      // dedupe + trim, preserve order
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of p.skills) {
        const trimmed = raw.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        cleaned.push(trimmed);
      }
      next.skills = cleaned;
    }
    list[idx] = next;
    const nextConfig: BitterbotConfig = {
      ...cfg,
      agents: {
        ...cfg.agents,
        list,
      },
    };
    await writeConfigFile(nextConfig);
    bumpSkillsSnapshotVersion({ reason: "manual" });
    respond(true, { ok: true, agentId, skills: next.skills ?? null }, undefined);
  },
  // Sandbox-style validator: parses frontmatter, runs the same prompt-
  // injection scanner the P2P ingest pipeline uses, and reports OS/bin
  // requirements. No persistence — purely a read on raw content.
  "skills.validate": ({ params, respond }) => {
    if (!validateSkillsValidateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.validate params: ${formatValidationErrors(validateSkillsValidateParams.errors)}`,
        ),
      );
      return;
    }
    const content = String(params.content ?? "");
    const diagnostics: Array<{
      severity: "error" | "warn" | "info";
      code: string;
      message: string;
    }> = [];

    let meta: Record<string, unknown> = {};
    let frontmatterClosed = false;
    if (content.trim().startsWith("---")) {
      const closeIdx = content.indexOf("\n---", 3);
      if (closeIdx !== -1) {
        frontmatterClosed = true;
        const block = content.slice(content.indexOf("\n", 3) + 1, closeIdx);
        try {
          const parsed = YAML.parse(block);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            meta = parsed as Record<string, unknown>;
          }
        } catch (err) {
          diagnostics.push({
            severity: "error",
            code: "frontmatter-invalid-yaml",
            message: `Frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
    if (!frontmatterClosed) {
      diagnostics.push({
        severity: "error",
        code: "frontmatter-missing",
        message: "SKILL.md must start with YAML frontmatter (---) and close with ---.",
      });
    }
    const name = typeof meta.name === "string" ? meta.name.trim() : "";
    const description = typeof meta.description === "string" ? meta.description.trim() : "";
    if (!name) {
      diagnostics.push({
        severity: "error",
        code: "missing-name",
        message: "Frontmatter must include a 'name:' field.",
      });
    } else if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(name)) {
      diagnostics.push({
        severity: "error",
        code: "invalid-name",
        message: "name must be lowercase letters, digits, and hyphens; 2–64 chars.",
      });
    }
    if (!description) {
      diagnostics.push({
        severity: "error",
        code: "missing-description",
        message: "Frontmatter must include a 'description:' field.",
      });
    } else if (description.length < 12) {
      diagnostics.push({
        severity: "warn",
        code: "thin-description",
        message: "description is very short — agents match skills via this text.",
      });
    }

    // OS compatibility — only a warning since users may target other platforms.
    const osField = meta.os;
    const osList = Array.isArray(osField)
      ? osField.filter((v): v is string => typeof v === "string")
      : typeof osField === "string"
        ? [osField]
        : [];
    if (osList.length > 0) {
      const here = process.platform;
      const supported = osList.some((entry) => {
        const lc = entry.toLowerCase();
        if (here === "darwin" && (lc === "darwin" || lc === "macos")) return true;
        if (here === "linux" && lc === "linux") return true;
        if (here === "win32" && (lc === "win32" || lc === "windows")) return true;
        return false;
      });
      if (!supported) {
        diagnostics.push({
          severity: "warn",
          code: "os-mismatch",
          message: `os: declared as ${osList.join(", ")} — this gateway runs ${here} so the skill will be hidden here.`,
        });
      }
    }

    // requires.bins — surface as info (we don't probe the system here).
    const requires = (meta.requires ?? {}) as { bins?: unknown; env?: unknown };
    const bins = Array.isArray(requires.bins)
      ? (requires.bins as unknown[]).filter((b): b is string => typeof b === "string")
      : [];
    const env = Array.isArray(requires.env)
      ? (requires.env as unknown[]).filter((e): e is string => typeof e === "string")
      : [];
    if (bins.length > 0) {
      diagnostics.push({
        severity: "info",
        code: "requires-bins",
        message: `Declares required bins: ${bins.join(", ")} (not probed by validator).`,
      });
    }
    if (env.length > 0) {
      diagnostics.push({
        severity: "info",
        code: "requires-env",
        message: `Declares required env vars: ${env.join(", ")} (not checked here).`,
      });
    }

    // Prompt-injection scanner — same one the P2P ingest pipeline uses.
    const scan = scanSkillForInjection(content);
    if (scan.severity === "critical") {
      diagnostics.push({
        severity: "error",
        code: "injection-critical",
        message: `Injection scanner critical: ${scan.reason || scan.flags.join(", ")}.`,
      });
    } else if (scan.severity === "medium") {
      diagnostics.push({
        severity: "warn",
        code: "injection-medium",
        message: `Injection scanner medium: ${scan.reason || scan.flags.join(", ")}.`,
      });
    } else if (scan.severity === "low") {
      diagnostics.push({
        severity: "info",
        code: "injection-low",
        message: `Injection scanner low-confidence flag: ${scan.flags.join(", ") || "none"}.`,
      });
    }

    const ok = !diagnostics.some((d) => d.severity === "error");
    respond(
      true,
      {
        ok,
        frontmatter: {
          name: name || undefined,
          description: description || undefined,
          emoji: typeof meta.emoji === "string" ? meta.emoji : undefined,
          primaryEnv: typeof meta.primaryEnv === "string" ? meta.primaryEnv : undefined,
          os: osList.length > 0 ? osList : undefined,
          requires:
            bins.length > 0 || env.length > 0
              ? {
                  bins: bins.length > 0 ? bins : undefined,
                  env: env.length > 0 ? env : undefined,
                }
              : undefined,
        },
        injectionScan: {
          severity: scan.severity,
          flags: scan.flags,
          weight: scan.weight,
          reason: scan.reason,
        },
        diagnostics,
      },
      undefined,
    );
  },
  // Sign + publish to the P2P skill gossipsub topic. The orchestrator handles
  // the actual signing using the local node identity key; we just hand it the
  // SKILL.md bytes (base64-encoded as the orchestrator IPC expects).
  "skills.publish": async ({ params, respond, context }) => {
    if (!validateSkillsPublishParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.publish params: ${formatValidationErrors(validateSkillsPublishParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    if (!cfg.p2p?.enabled) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "p2p is disabled (set p2p.enabled = true)"),
      );
      return;
    }
    if (!context.orchestratorBridge) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "p2p orchestrator bridge is not available"),
      );
      return;
    }
    const p = params as { name: string; content: string };
    // Quick sanity check: refuse to publish content that fails the
    // injection scanner outright. Mirrors what the inbound side enforces.
    const scan = scanSkillForInjection(p.content);
    if (scan.severity === "critical") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `refusing to publish: injection scanner flagged critical (${scan.reason || scan.flags.join(", ")})`,
        ),
      );
      return;
    }
    const skillMdBase64 = Buffer.from(p.content, "utf8").toString("base64");
    try {
      const raw = (await context.orchestratorBridge.publishSkill(skillMdBase64, p.name)) as
        | {
            ok?: boolean;
            content_hash?: string;
            delivered_to?: number;
            error?: string;
          }
        | undefined;
      const result = {
        ok: raw?.ok === true,
        contentHash: raw?.content_hash,
        deliveredTo: raw?.delivered_to,
        error: raw?.error,
      };
      respond(
        result.ok,
        result,
        result.ok
          ? undefined
          : errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "publish failed"),
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `publish failed: ${String(err)}`),
      );
    }
  },
  // Best-effort upload to agentskills.io. Posts SKILL.md to a documented
  // skills endpoint with the configured API key. If the registry's API
  // contract differs, the response surfaces the upstream error verbatim
  // so the user can adjust their key/URL.
  "skills.uploadAgentskills": async ({ params, respond }) => {
    if (!validateSkillsUploadAgentskillsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.uploadAgentskills params: ${formatValidationErrors(validateSkillsUploadAgentskillsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const ask = cfg.skills?.agentskills;
    if (!ask?.enabled) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "agentskills.io bridge is disabled (set skills.agentskills.enabled = true)",
        ),
      );
      return;
    }
    if (!ask.apiKey) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "agentskills.io upload requires skills.agentskills.apiKey to be set",
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      content: string;
      title?: string;
      visibility?: "public" | "unlisted";
    };
    const baseUrl = (ask.registryBaseUrl ?? "https://agentskills.io").replace(/\/+$/, "");
    const endpoint = `${baseUrl}/api/skills`;
    const body = {
      name: p.name,
      title: p.title ?? p.name,
      visibility: p.visibility ?? "public",
      content: p.content,
    };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ask.apiKey}`,
          "content-type": "application/json",
          "user-agent": "bitterbot-control-ui",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text().catch(() => "");
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          // Non-JSON response — pass back the raw text below.
        }
      }
      if (!res.ok) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `agentskills.io upload returned ${res.status}: ${
              (json &&
              typeof json === "object" &&
              "error" in json &&
              typeof (json as { error: unknown }).error === "string"
                ? (json as { error: string }).error
                : null) ??
              text.slice(0, 240) ??
              "no response body"
            }`,
          ),
        );
        return;
      }
      const obj = (json && typeof json === "object" ? json : {}) as {
        slug?: string;
        url?: string;
      };
      respond(
        true,
        {
          ok: true,
          slug: typeof obj.slug === "string" ? obj.slug : undefined,
          upstreamUrl:
            typeof obj.url === "string"
              ? obj.url
              : obj.slug
                ? `${baseUrl}/skills/${obj.slug}`
                : undefined,
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `agentskills.io upload failed: ${String(err)}`),
      );
    }
  },
  // Trust settings for skill ingestion. Same write pattern as skills.update —
  // direct config write, bump snapshot version, no gateway restart. The
  // running gateway's runtime caches re-read on the snapshot bump.
  "skills.updateTrustSettings": async ({ params, respond }) => {
    if (!validateSkillsUpdateTrustSettingsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.updateTrustSettings params: ${formatValidationErrors(validateSkillsUpdateTrustSettingsParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      p2p?: {
        ingestPolicy?: "auto" | "review" | "deny";
        maxIngestedPerHour?: number;
        injectionScanner?: "regex" | "off";
        quarantineTtlDays?: number;
      };
      agentskills?: {
        enabled?: boolean;
        defaultTrust?: "auto" | "review";
      };
    };
    const cfg = loadConfig();
    const skills = cfg.skills ? { ...cfg.skills } : {};
    if (p.p2p) {
      const p2p = skills.p2p ? { ...skills.p2p } : {};
      if (p.p2p.ingestPolicy !== undefined) p2p.ingestPolicy = p.p2p.ingestPolicy;
      if (p.p2p.maxIngestedPerHour !== undefined) p2p.maxIngestedPerHour = p.p2p.maxIngestedPerHour;
      if (p.p2p.injectionScanner !== undefined) p2p.injectionScanner = p.p2p.injectionScanner;
      if (p.p2p.quarantineTtlDays !== undefined) p2p.quarantineTtlDays = p.p2p.quarantineTtlDays;
      skills.p2p = p2p;
    }
    if (p.agentskills) {
      const ask = skills.agentskills ? { ...skills.agentskills } : {};
      if (p.agentskills.enabled !== undefined) ask.enabled = p.agentskills.enabled;
      if (p.agentskills.defaultTrust !== undefined) ask.defaultTrust = p.agentskills.defaultTrust;
      skills.agentskills = ask;
    }
    const nextConfig: BitterbotConfig = {
      ...cfg,
      skills,
    };
    await writeConfigFile(nextConfig);
    bumpSkillsSnapshotVersion({ reason: "manual" });
    respond(true, { ok: true, p2p: skills.p2p, agentskills: skills.agentskills }, undefined);
  },

  // ── PLAN-15 Phase 2c: staging-gated skill mutation surface ──────────────
  //
  // Lifecycle metrics live in the per-agent memory DB; we open a short-lived
  // WAL-mode connection per call so the regression-baseline branch of the
  // gate fires even from this entry point. If the connection fails to open
  // (missing DB, schema mismatch), we degrade to schema + injection gates
  // only rather than failing the request.
  "skills.manage": async ({ params, respond }) => {
    if (!validateSkillsManageParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.manage params: ${formatValidationErrors(validateSkillsManageParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as unknown as SkillManageParams;
    const roots = resolveStorageRoots();
    const cfg = loadConfig();
    try {
      const result = await withSkillLifecycleStore({ config: cfg }, (store) =>
        skillManage({ storageRoots: roots, ...(store ? { lifecycleStore: store } : {}) }, p),
      );
      const payload = {
        ok: result.ok,
        action: result.action,
        name: result.name,
        ...(result.stagedFilePath ? { stagedFilePath: result.stagedFilePath } : {}),
        ...(result.gate
          ? {
              gateOutcome: result.gate.outcome,
              gateSummary: result.gateSummary,
              gateIssues: result.gate.issues,
              baselineRuns: result.gate.baselineRuns,
              baselineSuccessRate: result.gate.baselineSuccessRate,
            }
          : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      };
      if (result.ok) {
        bumpSkillsSnapshotVersion({ reason: "manual" });
      }
      respond(
        result.ok,
        payload,
        result.ok
          ? undefined
          : errorShape(ErrorCodes.UNAVAILABLE, result.detail ?? "manage failed"),
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `skills.manage threw: ${String(err)}`),
      );
    }
  },

  "skills.promote": async ({ params, respond, client }) => {
    if (!validateSkillsPromoteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.promote params: ${formatValidationErrors(validateSkillsPromoteParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      reason?: string;
      author?: string;
      forceGate?: boolean;
    };
    const roots = resolveStorageRoots();
    const cfg = loadConfig();
    // PLAN-44 Phase 3: an evolution-staged skill is promotable here only as
    // an explicit override from an operator.admin connection (adversarial
    // H2: `author` is a caller-asserted param, scopes are not).
    const operatorOverride =
      p.forceGate === true && (client?.connect?.scopes ?? []).includes("operator.admin");
    try {
      const result = await withSkillLifecycleStore({ config: cfg }, (store) =>
        promoteStaged(
          { storageRoots: roots, ...(store ? { lifecycleStore: store } : {}) },
          {
            name: p.name,
            ...(p.reason ? { reason: p.reason } : {}),
            ...(p.author ? { author: p.author } : {}),
            ...(p.forceGate ? { forceGate: true } : {}),
            ...(operatorOverride ? { allowEvolutionStaged: true } : {}),
          },
        ),
      );
      const payload = {
        ok: result.ok,
        ...(result.kind ? { kind: result.kind } : {}),
        ...(result.previousArchived
          ? { previousArchivedVersion: result.previousArchived.version }
          : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      };
      if (result.ok) {
        bumpSkillsSnapshotVersion({ reason: "manual" });
      }
      await appendImpactEntry({
        source: "skill-manage",
        action: "promote",
        skillName: p.name,
        verdict: result.ok ? "accepted" : "rejected",
        detail: result.ok
          ? `kind=${result.kind}; archived previous v${result.previousArchived?.version ?? "none"}${p.forceGate ? "; forceGate=true" : ""}`
          : (result.detail ?? result.error ?? "promote failed"),
      });
      respond(
        result.ok,
        payload,
        result.ok
          ? undefined
          : errorShape(ErrorCodes.UNAVAILABLE, result.detail ?? "promote failed"),
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `skills.promote threw: ${String(err)}`),
      );
    }
  },

  "skills.rollback": async ({ params, respond }) => {
    if (!validateSkillsRollbackParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.rollback params: ${formatValidationErrors(validateSkillsRollbackParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      version: number;
      reason?: string;
      author?: string;
    };
    const roots = resolveStorageRoots();
    const cfg = loadConfig();
    try {
      const result = await withSkillLifecycleStore({ config: cfg }, (store) =>
        rollbackStaged(
          { storageRoots: roots, ...(store ? { lifecycleStore: store } : {}) },
          {
            name: p.name,
            version: p.version,
            ...(p.reason ? { reason: p.reason } : {}),
            ...(p.author ? { author: p.author } : {}),
          },
        ),
      );
      const payload = {
        ok: result.ok,
        ...(result.previousArchived
          ? { previousArchivedVersion: result.previousArchived.version }
          : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      };
      if (result.ok) {
        bumpSkillsSnapshotVersion({ reason: "manual" });
      }
      if (result.ok) {
        await appendImpactEntry({
          source: "skill-manage",
          action: "rollback",
          skillName: p.name,
          verdict: "rolled-back",
          detail: `restored v${p.version}; pre-rollback snapshot v${result.previousArchived?.version ?? "none"}`,
        });
      }
      respond(
        result.ok,
        payload,
        result.ok
          ? undefined
          : errorShape(ErrorCodes.UNAVAILABLE, result.detail ?? "rollback failed"),
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `skills.rollback threw: ${String(err)}`),
      );
    }
  },

  // PLAN-42 Phase 5: one read-only snapshot of the evolution flywheel —
  // wiki size, sampler cursor, staged/held proposals, validated evolved
  // skills, P2P eligibility, corpus presence — plus the effective config.
  // PLAN-44 Phase 2: the corpus review surface. Drafts the miner wrote to
  // task-corpus-pending.jsonl become live capability tasks only here.
  "skills.evolution.corpus.list": async ({ respond }) => {
    try {
      const { listPendingDrafts } = await import("../../memory/skill-evolution/corpus-review.js");
      const { loadEffectiveCorpus } =
        await import("../../memory/skill-evolution/canonical-corpus.js");
      const { countCapabilityTasks, TASKS_MODE_MIN_CAPABILITY_TASKS } =
        await import("../../memory/skill-evolution/validation-mode.js");
      const drafts = await listPendingDrafts();
      const corpus = await loadEffectiveCorpus();
      respond(true, {
        drafts,
        liveCapabilityTasks: countCapabilityTasks(corpus),
        tasksModeThreshold: TASKS_MODE_MIN_CAPABILITY_TASKS,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `skills.evolution.corpus.list threw: ${String(err)}`),
      );
    }
  },
  "skills.evolution.corpus.accept": async ({ params, respond }) => {
    if (!validateSkillsEvolutionCorpusReviewParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.evolution.corpus.accept params: ${formatValidationErrors(validateSkillsEvolutionCorpusReviewParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const { acceptDrafts } = await import("../../memory/skill-evolution/corpus-review.js");
      const p = params as { ids: string[]; reviewedBy?: string };
      const result = await acceptDrafts(p.ids, { reviewedBy: p.reviewedBy ?? "operator" });
      respond(true, result);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `skills.evolution.corpus.accept threw: ${String(err)}`),
      );
    }
  },
  "skills.evolution.corpus.reject": async ({ params, respond }) => {
    if (!validateSkillsEvolutionCorpusReviewParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.evolution.corpus.reject params: ${formatValidationErrors(validateSkillsEvolutionCorpusReviewParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const { rejectDrafts } = await import("../../memory/skill-evolution/corpus-review.js");
      const p = params as { ids: string[]; reviewedBy?: string; reason?: string };
      const result = await rejectDrafts(p.ids, {
        reviewedBy: p.reviewedBy ?? "operator",
        ...(p.reason ? { reason: p.reason } : {}),
      });
      respond(true, result);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `skills.evolution.corpus.reject threw: ${String(err)}`),
      );
    }
  },

  // PLAN-44 Phase 2: in-process probe of the runtime-pathway validation arm
  // (one candidate skill, one task, both arms). The workspace registry only
  // honours scratch dirs registered by THIS process, so an operator cannot
  // exercise the arm from outside; this RPC is the supported way.
  /**
   * PLAN-44 Phase 5c: rewrite non-routable live descriptions now (the
   * housekeeping pass does the same on cadence). `dryRun` lists candidates.
   */
  "skills.evolution.routing.repair": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { dryRun?: boolean; max?: number; name?: string };
      const { listNonRoutableSkills, repairNonRoutableSkills, repairSkillRouting } =
        await import("../../memory/skill-evolution/routing-repair.js");
      if (p.dryRun) {
        respond(true, { candidates: await listNonRoutableSkills() });
        return;
      }
      const { getActiveEvolutionLlm } = await import("../../memory/skill-evolution/active-llm.js");
      const llmCall = getActiveEvolutionLlm();
      if (!llmCall) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "no evolution model lane available (memory not ready or no LLM configured)",
          ),
        );
        return;
      }
      if (typeof p.name === "string" && p.name.trim()) {
        const r = await repairSkillRouting({ llmCall, name: p.name.trim() });
        respond(true, { outcomes: [r.outcome], llmCalls: r.llmCalls });
        return;
      }
      const r = await repairNonRoutableSkills({
        llmCall,
        ...(typeof p.max === "number" ? { max: p.max } : {}),
      });
      respond(true, r);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `skills.evolution.routing.repair threw: ${String(err)}`),
      );
    }
  },
  "skills.evolution.probe": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { skillMd?: string; taskPrompt?: string; expected?: string };
      const [
        { makeGatewayAgentTurn, makeRuntimePathwayRunner },
        { callGateway },
        { INTERNAL_MESSAGE_CHANNEL },
        { resolveDefaultAgentId },
        { makeSkillEvolveValidationSessionKey },
        { getActiveEventJournal },
        { scoreTaskAnswer },
      ] = await Promise.all([
        import("../../memory/skill-evolution/task-runner.js"),
        import("../call.js"),
        import("../../utils/message-channel.js"),
        import("../../agents/agent-scope.js"),
        import("../../sessions/session-key-utils.js"),
        import("../../infra/event-journal.js"),
        import("../../memory/skill-evolution/task-corpus.js"),
      ]);
      const cfg = loadConfig();
      const agentId = resolveDefaultAgentId(cfg);
      const skillMd =
        p.skillMd ??
        `---
name: probe-token-guard
description: Apply whenever a task mentions the violet-owl protocol; it defines how to report the protocol token.
---
## When to Apply
Any task that mentions the violet-owl protocol.
## Instructions
The violet-owl protocol token is VIOLET-OWL-77. Report it on the FINAL line exactly as VIOLET-OWL-77.
`;
      const name = skillMd.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "probe-skill";
      const task = {
        id: "probe-task",
        prompt:
          p.taskPrompt ??
          'Using the violet-owl protocol, report the protocol token. Reply with exactly one line of the form "FINAL: <answer>".',
        checker: { kind: "final" as const, value: p.expected ?? "VIOLET-OWL-77" },
        suite: "capability" as const,
      };
      const agentTurn = makeGatewayAgentTurn({
        callGateway: (a) =>
          callGateway({
            method: a.method,
            params: a.params,
            ...(a.expectFinal !== undefined ? { expectFinal: a.expectFinal } : {}),
            ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}),
          }),
        agentId,
        channel: INTERNAL_MESSAGE_CHANNEL,
        makeSessionKey: () =>
          makeSkillEvolveValidationSessionKey(agentId, globalThis.crypto.randomUUID().slice(0, 8)),
        makeIdempotencyKey: () => globalThis.crypto.randomUUID(),
      });
      const runner = makeRuntimePathwayRunner({
        agentTurn,
        journal: getActiveEventJournal(),
        candidate: { name, content: skillMd },
        incumbent: null,
        proposalId: `probe-${Date.now()}`,
      });
      const out: Record<string, unknown> = {};
      for (const variant of ["candidate", "incumbent"] as const) {
        const t0 = Date.now();
        const r = await runner(task, variant, { trialIndex: 0 });
        const rr = typeof r === "string" ? { answer: r } : r;
        out[variant] = {
          ms: Date.now() - t0,
          score: scoreTaskAnswer(task, rr.answer),
          skillRead: rr.skillRead ?? null,
          usage: rr.usage ?? null,
          answer: rr.answer.slice(0, 300),
        };
      }
      respond(true, { task: task.id, skill: name, ...out });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `skills.evolution.probe threw: ${String(err)}`),
      );
    }
  },

  "skills.evolution.status": async ({ respond }) => {
    try {
      const { collectEvolutionStatus } = await import("../../memory/skill-evolution/status.js");
      const { loadEffectiveCorpus } =
        await import("../../memory/skill-evolution/canonical-corpus.js");
      const { countCapabilityTasks, resolveEffectiveValidationMode } =
        await import("../../memory/skill-evolution/validation-mode.js");
      const { listPendingDrafts } = await import("../../memory/skill-evolution/corpus-review.js");
      const { summarizeSkillReads } = await import("../../memory/skill-evolution/skill-reads.js");
      const { listLiveSkillIndex } = await import("../../agents/skills/description-overlap.js");
      const status = await collectEvolutionStatus();
      // PLAN-44 Phase 5a: the usage signal per live skill (14-day window).
      const liveIndex = await listLiveSkillIndex(resolveStorageRoots());
      const skillReads = await summarizeSkillReads({ liveNames: liveIndex.map((e) => e.name) });
      const cfg = loadConfig();
      const evo = cfg.skills?.evolution ?? {};
      const capabilityTasks = countCapabilityTasks(await loadEffectiveCorpus());
      const effectiveMode = resolveEffectiveValidationMode(evo.validationMode, capabilityTasks);
      const pendingDrafts = (await listPendingDrafts()).length;
      // PLAN-44 Phase 0: echo the FULL effective config (the audit found the
      // RPC reported 6 of 12 fields). Defaults mirror src/config/zod-schema.ts.
      respond(true, {
        config: {
          enabled: evo.enabled !== false,
          cadenceHours: evo.cadenceHours ?? 24,
          maxProposerTurns: evo.maxProposerTurns ?? 24,
          maxActiveEvolved: evo.maxActiveEvolved ?? 5,
          validationMode: evo.validationMode ?? "records",
          validationModeEffective: effectiveMode.mode,
          validationModeSource: effectiveMode.source,
          validationBudgetMinutes: evo.validationBudgetMinutes ?? 45,
          descriptionRepair: evo.descriptionRepair !== false,
          routingRepair: evo.routingRepair !== false,
          capabilityTasks,
          pendingDrafts,
          trialsPerTask: evo.trialsPerTask ?? 3,
          judgeModel: evo.judgeModel ?? null,
          proposerModel: evo.proposerModel ?? null,
          proposerModelSource: evo.proposerModel
            ? "config"
            : evo.judgeModel
              ? "judgeModel"
              : "agent-primary",
          proposerModelConfigured:
            evo.proposerModel ??
            evo.judgeModel ??
            (() => {
              try {
                const ref = resolveDefaultModelForAgent({ cfg });
                return `${ref.provider}/${ref.model}`;
              } catch {
                return null;
              }
            })(),
          wikiMaxPatterns: evo.wikiMaxPatterns ?? 100,
          semanticLintCadenceDays: evo.semanticLintCadenceDays ?? 7,
          propagate: evo.propagate !== false,
          maturityDays: evo.maturityDays ?? 3,
        },
        ...status,
        skillReads,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `skills.evolution.status threw: ${String(err)}`),
      );
    }
  },
};
