import fs from "node:fs/promises";
import path from "node:path";
import type { CrystallizationCandidate } from "../../agents/skills/types.js";
import type { BitterbotConfig } from "../../config/config.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { installSkill } from "../../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import { importAgentskillsSkill } from "../../agents/skills/agentskills-ingest.js";
import { crystallizeSkill } from "../../agents/skills/crystallize.js";
import {
  acceptIncomingSkill,
  listIncomingSkills,
  rejectIncomingSkill,
  rejectIncomingSkillsByPeer,
} from "../../agents/skills/ingest.js";
import { bumpSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { CONFIG_DIR } from "../../utils.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsCreateParams,
  validateSkillsInstallParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";

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
    const cfg = loadConfig();
    const p2p = cfg.p2p;
    let stats = null;
    let bootstrapCensus = null;
    if (context.orchestratorBridge) {
      try {
        stats = await context.orchestratorBridge.getStats();
      } catch {}
      try {
        bootstrapCensus = await context.orchestratorBridge.getBootstrapCensus();
      } catch {}
    }
    // Local lifetime metrics from the SQLite peer_reputation table — these
    // are independent of the live swarm: they survive restarts and capture
    // every peer the node has ever met.
    const localMetrics = context.skillNetworkBridge?.getNetworkMetrics?.() ?? null;
    // Latest network-wide census heard over gossipsub from a bootnode. Lets
    // a management node answer "how many peers has the network ever seen?"
    // in real time without polling the bootnode's HTTP endpoint.
    const networkCensus = context.skillNetworkBridge?.getLatestNetworkCensus?.() ?? null;
    respond(
      true,
      {
        enabled: p2p?.enabled ?? false,
        topics: p2p?.topics ?? {},
        security: p2p?.security ?? {},
        stats,
        localMetrics,
        bootstrapCensus,
        networkCensus,
      },
      undefined,
    );
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
    const rows =
      context.skillNetworkBridge?.getNetworkCensusHistory?.({ sourcePeerId, sinceMs, limit }) ?? [];
    respond(true, { rows: rows ?? [], count: rows?.length ?? 0 }, undefined);
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
    bumpSkillsSnapshotVersion({ reason: "manual", changedPath: skillPath });
    respond(true, { ok: true, skillName: sanitizedName, skillPath, target }, undefined);
  },
  "skills.incoming.list": async ({ respond }) => {
    const cfg = loadConfig();
    const skills = await listIncomingSkills(cfg);
    respond(true, { skills }, undefined);
  },
  "skills.incoming.accept": async ({ params, respond }) => {
    const skillName = typeof params?.skillName === "string" ? params.skillName.trim() : "";
    if (!skillName) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "skillName required"));
      return;
    }
    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const result = await acceptIncomingSkill({ skillName, config: cfg, workspaceDir });
    respond(
      result.ok,
      result,
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
    const result = await rejectIncomingSkill({ skillName, config: cfg });
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
};
