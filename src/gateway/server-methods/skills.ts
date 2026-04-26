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
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
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
    if (context.orchestratorBridge) {
      try {
        stats = await context.orchestratorBridge.getStats();
      } catch {}
    }
    respond(
      true,
      {
        enabled: p2p?.enabled ?? false,
        topics: p2p?.topics ?? {},
        security: p2p?.security ?? {},
        stats,
      },
      undefined,
    );
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
    respond(true, { ok: true, skillKey: p.skillKey, config: current }, undefined);
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
