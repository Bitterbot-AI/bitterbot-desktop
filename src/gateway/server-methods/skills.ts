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
  validateSkillsMetricsParams,
  validateSkillsPublishParams,
  validateSkillsStatusParams,
  validateSkillsUpdateAgentFilterParams,
  validateSkillsUpdateParams,
  validateSkillsUpdateTrustSettingsParams,
  validateSkillsUploadAgentskillsParams,
  validateSkillsValidateParams,
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
};
