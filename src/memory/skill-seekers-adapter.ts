/**
 * Adapter for Skill Seekers (https://github.com/yusufkaraaslan/Skill_Seekers)
 * by Yusuf Karaaslan. MIT License.
 *
 * Converts external documentation sources into Bitterbot SkillEnvelopes via the
 * existing trust/quality pipeline. Skills enter as untrusted (synthetic peer)
 * and are promoted through execution feedback.
 *
 * Transports (priority order):
 *   1. Native TypeScript scraper (docs + GitHub) — zero-install, always available
 *   2. Configured MCP endpoint (HTTP POST) — containerized/remote setups
 *   3. Local `skill-seekers` CLI binary — covers 17+ source types
 *   4. Python module fallback (`python3 -m skill_seekers`) — same coverage as CLI
 *
 * Source-type routing: the native scraper handles HTML docs and GitHub repos.
 * For PDFs, video transcripts, Jupyter notebooks, Confluence, Notion, and
 * other complex sources, the adapter falls through to the upstream transports.
 * See `classifyNativeSource()` in skill-seekers-native.ts for routing.
 *
 * Feedback loops this adapter participates in:
 *   - Curiosity: knowledge_gap targets drive exploration-mode scraping
 *   - Marketplace: market_demand targets are tagged so revenue can be attributed
 *   - Epistemic directives: high-severity conflicts in scraped skills are promoted
 *     to directives, creating new curiosity targets that close the loop
 *   - TTL: auto-generated skills expire; the memory lifecycle can prune stale ones
 */

import type { DatabaseSync } from "node:sqlite";
import { execFile, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SkillEnvelope, IngestResult } from "../agents/skills/ingest.js";
import type { BitterbotConfig } from "../config/config.js";
import type { SkillSeekersConfig } from "../config/types.skill-seekers.js";
import { ingestSkill } from "../agents/skills/ingest.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import { classifyNativeSource, runNativeScraper } from "./skill-seekers-native.js";
import { reconcileEnvelope } from "./skill-seekers-reconciler.js";

const log = createSubsystemLogger("skill-seekers");
const execFileAsync = promisify(execFile);

// ── Constants ──

export const SKILL_SEEKERS_PEER_ID = "local-skill-seekers";
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

// Ed25519 SPKI DER prefix for raw 32-byte public keys
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEFAULT_MAX_SKILLS_PER_CYCLE = 3;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_TTL_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const CLI_VERSION_TIMEOUT_MS = 5_000;
const CLI_RUN_TIMEOUT_MS = 120_000;
const MCP_HTTP_TIMEOUT_MS = 150_000;

// ── Ed25519 keypair for signing envelopes ──

type SyntheticKeypair = {
  publicKeyBase64: string; // raw 32-byte pubkey, base64-encoded
  privateKeyPem: string;
};

/**
 * Generate (or load cached) Ed25519 keypair for the synthetic peer.
 * The keypair is deterministic per DB — stored in a meta table so the
 * pubkey remains stable across restarts (matching peer_reputation).
 */
function loadOrCreateSyntheticKeypair(db: DatabaseSync): SyntheticKeypair {
  // Try loading from DB
  try {
    const row = db
      .prepare(`SELECT value FROM memory_meta WHERE key = 'skill_seekers_keypair'`)
      .get() as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as SyntheticKeypair;
      if (parsed.publicKeyBase64 && parsed.privateKeyPem) {
        return parsed;
      }
    }
  } catch {
    // Table may not exist or row missing — generate new
  }

  // Generate fresh Ed25519 keypair
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  // Extract raw 32-byte pubkey from SPKI DER (skip the 12-byte prefix)
  const rawPubkey = spkiDer.subarray(ED25519_SPKI_PREFIX.length);
  const keypair: SyntheticKeypair = {
    publicKeyBase64: rawPubkey.toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };

  // Persist
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(
      `INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('skill_seekers_keypair', ?)`,
    ).run(JSON.stringify(keypair));
  } catch {
    // Best-effort persistence
  }

  return keypair;
}

function signEnvelope(skillMdBase64: string, privateKeyPem: string): string {
  const skillBytes = Buffer.from(skillMdBase64, "base64");
  const privateKey = { key: privateKeyPem, format: "pem" as const, type: "pkcs8" as const };
  const sig = sign(null, skillBytes, privateKey);
  return sig.toString("base64");
}

// ── Types ──

export type SkillSeekersSource = {
  url: string;
  type?: "docs" | "github" | "pdf" | "video" | "codebase";
  name?: string;
  description?: string;
  /** Optional marketplace context — when present, envelope is tagged for revenue attribution. */
  marketplace?: {
    category: string;
    expectedRevenueUsdc?: number;
    demandScore?: number;
    opportunityId?: string;
  };
  /** Free-form provenance fields that flow through to .provenance.json. */
  provenance?: Record<string, unknown>;
};

export type SkillSeekersResult = {
  ok: boolean;
  envelopes: SkillEnvelope[];
  ingested: IngestResult[];
  conflicts: SkillSeekersConflict[];
  error?: string;
  sourceUrl: string;
  elapsedMs: number;
  /** Transport used to produce this result (for observability). */
  transport?: "native" | "mcp" | "cli" | "python";
};

export type SkillSeekersBatchResult = {
  total: number;
  succeeded: number;
  failed: number;
  results: SkillSeekersResult[];
  elapsedMs: number;
};

export type SkillSeekersConflict = {
  type: "missing_in_docs" | "missing_in_code" | "signature_mismatch" | "description_mismatch";
  severity: "low" | "medium" | "high";
  apiName: string;
  difference: string | null;
  suggestion: string | null;
};

// ── Dependency interfaces (lazy-injected) ──

type EpistemicDirectiveEngineLike = {
  createDirective(params: {
    type: "contradiction" | "knowledge_gap" | "low_confidence" | "stale_fact";
    question: string;
    context?: string;
    priority?: number;
    sourceEntityIds?: string[];
  }): unknown;
};

type MarketplaceIntelligenceLike = {
  analyzeOpportunities(limit?: number): Array<{
    category: string;
    demandScore: number;
    readinessScore: number;
    expectedRevenueUsdc: number;
    targetDescription: string;
  }>;
};

type WebSearchLike = {
  findAuthoritativeUrl(query: string, hints?: { category?: string }): Promise<string | null>;
};

// ── Adapter ──

export class SkillSeekersAdapter {
  private readonly db: DatabaseSync;
  private readonly keypair: SyntheticKeypair;
  readonly pubkey: string; // base64 raw Ed25519 pubkey — used as author_pubkey in envelopes
  private readonly config: Required<
    Pick<SkillSeekersConfig, "maxSkillsPerCycle" | "maxConcurrentScrapes" | "defaultTtlDays">
  > & {
    enabled: boolean;
    allowedDomains: string[];
    blockedDomains: string[];
    mcpEndpoint: string | null;
    useWebSearchFallback: boolean;
    enableMarketplaceDemand: boolean;
  };
  private epistemicDirectiveEngine: EpistemicDirectiveEngineLike | null = null;
  private marketplaceIntelligence: MarketplaceIntelligenceLike | null = null;
  private webSearch: WebSearchLike | null = null;
  private bitterbotConfig: BitterbotConfig | null = null;
  private skillsGeneratedThisCycle = 0;
  private transportProbe: {
    kind: "native" | "mcp" | "cli" | "python";
    probedAt: number;
  } | null = null;

  constructor(db: DatabaseSync, config?: SkillSeekersConfig) {
    this.db = db;
    this.keypair = loadOrCreateSyntheticKeypair(db);
    this.pubkey = this.keypair.publicKeyBase64;
    this.config = {
      enabled: config?.enabled !== false,
      maxSkillsPerCycle: config?.maxSkillsPerCycle ?? DEFAULT_MAX_SKILLS_PER_CYCLE,
      maxConcurrentScrapes: config?.maxConcurrentScrapes ?? DEFAULT_MAX_CONCURRENT,
      allowedDomains: config?.allowedDomains ?? [],
      blockedDomains: config?.blockedDomains ?? [],
      defaultTtlDays: config?.defaultTtlDays ?? DEFAULT_TTL_DAYS,
      mcpEndpoint: config?.mcpEndpoint ?? null,
      useWebSearchFallback: config?.useWebSearchFallback ?? true,
      enableMarketplaceDemand: config?.enableMarketplaceDemand ?? true,
    };
    this.ensureSyntheticPeer();
  }

  // ── Dependency injection (lazy setters) ──

  setEpistemicDirectiveEngine(engine: EpistemicDirectiveEngineLike | null): void {
    this.epistemicDirectiveEngine = engine;
  }

  setMarketplaceIntelligence(mi: MarketplaceIntelligenceLike | null): void {
    this.marketplaceIntelligence = mi;
  }

  setWebSearch(search: WebSearchLike | null): void {
    this.webSearch = search;
  }

  setBitterbotConfig(cfg: BitterbotConfig): void {
    this.bitterbotConfig = cfg;
  }

  /** Reset per-cycle counter (call at start of each dream cycle). */
  resetCycleCounter(): void {
    this.skillsGeneratedThisCycle = 0;
  }

  /** How many skills generated this cycle (for observability / dream engine pacing). */
  skillsThisCycle(): number {
    return this.skillsGeneratedThisCycle;
  }

  /** Remaining budget this cycle. */
  budgetRemaining(): number {
    return Math.max(0, this.config.maxSkillsPerCycle - this.skillsGeneratedThisCycle);
  }

  // ── Availability detection ──

  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }
    // Native is always available (pure TS), so when enabled, at least the
    // common-case path always works. Upstream detection is best-effort and
    // only matters for source types native can't handle.
    return true;
  }

  /**
   * Pick the best transport for a specific source URL.
   *
   *   1. If the URL is a docs site or GitHub repo, prefer the native scraper
   *      (zero install, reuses our SSRF-hardened fetch + Mozilla Readability).
   *   2. Otherwise probe upstream transports (MCP → CLI → Python module) for
   *      PDF / video / Jupyter / Confluence / Notion / codebase support.
   *
   * Upstream probes are cached for 5 minutes to avoid re-probing during bursts.
   */
  private async resolveTransport(
    sourceUrl: string,
  ): Promise<"native" | "mcp" | "cli" | "python" | null> {
    // Step 1: native scraper for URLs it can handle
    if (classifyNativeSource(sourceUrl) !== null) {
      return "native";
    }

    // Step 2: upstream probe (cached)
    const now = Date.now();
    if (this.transportProbe && now - this.transportProbe.probedAt < 5 * 60_000) {
      return this.transportProbe.kind;
    }

    if (this.config.mcpEndpoint) {
      if (await probeMcpEndpoint(this.config.mcpEndpoint)) {
        this.transportProbe = { kind: "mcp", probedAt: now };
        log.info(`Skill Seekers MCP endpoint reachable: ${this.config.mcpEndpoint}`);
        return "mcp";
      }
    }
    if (probeCliBinary("skill-seekers")) {
      this.transportProbe = { kind: "cli", probedAt: now };
      log.info("Skill Seekers CLI detected");
      return "cli";
    }
    if (probePythonModule()) {
      this.transportProbe = { kind: "python", probedAt: now };
      log.info("Skill Seekers Python module detected");
      return "python";
    }
    return null;
  }

  // ── Core: ingest from URL source ──

  async ingestFromSource(source: SkillSeekersSource): Promise<SkillSeekersResult> {
    const start = Date.now();
    const base: Omit<SkillSeekersResult, "ok" | "envelopes" | "ingested" | "elapsedMs"> = {
      conflicts: [],
      sourceUrl: source.url,
    };

    const transport = await this.resolveTransport(source.url);
    if (!transport) {
      return {
        ...base,
        ok: false,
        envelopes: [],
        ingested: [],
        error:
          "skill-seekers transport not available for this source type " +
          "(install `skill-seekers` CLI or configure skills.skillSeekers.mcpEndpoint for PDF/video/Jupyter/Confluence/Notion URLs)",
        elapsedMs: Date.now() - start,
      };
    }

    if (!this.isDomainAllowed(source.url)) {
      return {
        ...base,
        ok: false,
        envelopes: [],
        ingested: [],
        error: "domain_blocked",
        elapsedMs: Date.now() - start,
      };
    }

    if (this.skillsGeneratedThisCycle >= this.config.maxSkillsPerCycle) {
      return {
        ...base,
        ok: false,
        envelopes: [],
        ingested: [],
        error: "rate_limit_exceeded",
        elapsedMs: Date.now() - start,
      };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
    try {
      // Run skill-seekers via chosen transport
      const outputDir = path.join(tmpDir, "output");
      await runSkillSeekers(source, outputDir, transport, this.config.mcpEndpoint);

      // Find the generated skill directory
      const skillDir = findSkillDir(outputDir);
      if (!skillDir) {
        return {
          ...base,
          ok: false,
          envelopes: [],
          ingested: [],
          error: "no skill output generated",
          elapsedMs: Date.now() - start,
          transport,
        };
      }

      // Parse SKILL.md + references
      const parsed = parseSkillDirectory(skillDir, source);
      if (!parsed) {
        return {
          ...base,
          ok: false,
          envelopes: [],
          ingested: [],
          error: "failed to parse SKILL.md",
          elapsedMs: Date.now() - start,
          transport,
        };
      }

      // Parse conflicts if available
      const conflicts = parseConflicts(skillDir);

      // Build envelope with TTL + marketplace provenance
      const expiresAt = Date.now() + this.config.defaultTtlDays * MS_PER_DAY;
      const marketplaceTagged = this.config.enableMarketplaceDemand && source.marketplace;
      const provenance: Record<string, unknown> = {
        ...source.provenance,
        source_url: source.url,
        ttl_days: this.config.defaultTtlDays,
        transport,
      };
      if (marketplaceTagged) {
        provenance.marketplace_opportunity = source.marketplace;
      }

      const tags = [
        "external-generated",
        "auto-research",
        `transport:${transport}`,
        ...(marketplaceTagged ? ["marketplace-demand"] : []),
      ];

      let envelope = createEnvelope(parsed.name, parsed.content, this.keypair, {
        category: source.type ?? source.marketplace?.category ?? inferCategory(source.url),
        tags,
        sourceUrl: source.url,
        expiresAt,
        provenance,
      });

      // PLAN-11 Gap 3: reconcile against existing scraped skills with the
      // same stable_skill_id before ingesting. Merges provenance forward,
      // skips redundant scrapes, replaces weaker versions, or writes as a
      // variant when quality is comparable.
      const quarantineDir =
        this.bitterbotConfig?.skills?.p2p?.quarantineDir ??
        path.join(CONFIG_DIR, "skills-incoming");
      const skillsDir = path.join(CONFIG_DIR, "skills");
      const skillMdBytes = Buffer.byteLength(parsed.content, "utf8");
      const decision = await reconcileEnvelope(envelope, skillMdBytes, {
        skillsDir,
        quarantineDir,
      });

      // Ingest through existing pipeline
      const ingested: IngestResult[] = [];
      if (decision.action === "skip-incoming") {
        log.info(
          `Skill Seekers skipped "${parsed.name}" (reconciled): ${decision.reason}. Kept existing "${decision.existingName}".`,
        );
        return {
          ...base,
          ok: true,
          envelopes: [envelope],
          ingested: [
            {
              ok: false,
              action: "rejected",
              reason: `reconciled:skip-incoming:${decision.reason}`,
            },
          ],
          conflicts,
          elapsedMs: Date.now() - start,
          transport,
        };
      }
      if (decision.action === "replace") {
        // Attach merged provenance so downstream ingest writes the richer history.
        envelope = { ...envelope, provenance: decision.mergedProvenance };
      }
      if (decision.action === "write-as-variant") {
        // Suffix the name + stable_skill_id so it lands beside the existing one.
        const variantName = `${parsed.name}-${decision.suffix}`;
        envelope = {
          ...envelope,
          name: variantName,
          stable_skill_id: envelope.stable_skill_id
            ? `${envelope.stable_skill_id}-${decision.suffix}`
            : undefined,
          tags: [...(envelope.tags ?? []), `variant:${decision.suffix}`],
        };
        log.info(
          `Skill Seekers keeping "${variantName}" as variant (reconciled): ${decision.reason}`,
        );
      }
      if (this.bitterbotConfig) {
        const result = await ingestSkill({
          envelope,
          config: this.bitterbotConfig,
        });
        ingested.push(result);
        this.skillsGeneratedThisCycle++;
        const reconcileNote =
          decision.action === "replace"
            ? ` (replaced "${decision.existingName}")`
            : decision.action === "write-as-variant"
              ? ` (variant of existing)`
              : "";
        log.info(
          `Skill Seekers ingested "${envelope.name}" from ${source.url} via ${transport}: ${result.action}${reconcileNote}`,
        );
      }

      // Convert high-severity conflicts to epistemic directives
      this.processConflicts(conflicts, source.url);

      return {
        ...base,
        ok: true,
        envelopes: [envelope],
        ingested,
        conflicts,
        elapsedMs: Date.now() - start,
        transport,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Skill Seekers failed for ${source.url}: ${msg}`);
      return {
        ...base,
        ok: false,
        envelopes: [],
        ingested: [],
        error: msg,
        elapsedMs: Date.now() - start,
        transport,
      };
    } finally {
      // Cleanup tmp
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }

  // ── Batch ingestion with concurrency ──

  /**
   * Ingest multiple sources with a concurrency cap. Honors maxSkillsPerCycle
   * across the entire batch — sources past the cap return rate_limit_exceeded
   * without spawning a subprocess.
   */
  async ingestBatch(sources: SkillSeekersSource[]): Promise<SkillSeekersBatchResult> {
    const start = Date.now();
    const results: SkillSeekersResult[] = [];
    const queue = [...sources];
    const concurrency = Math.max(1, this.config.maxConcurrentScrapes);

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const source = queue.shift();
        if (!source) {
          return;
        }
        if (this.skillsGeneratedThisCycle >= this.config.maxSkillsPerCycle) {
          results.push({
            ok: false,
            envelopes: [],
            ingested: [],
            conflicts: [],
            sourceUrl: source.url,
            error: "rate_limit_exceeded",
            elapsedMs: 0,
          });
          continue;
        }
        results.push(await this.ingestFromSource(source));
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, sources.length) }, () => worker());
    await Promise.all(workers);

    const succeeded = results.filter((r) => r.ok).length;
    return {
      total: sources.length,
      succeeded,
      failed: sources.length - succeeded,
      results,
      elapsedMs: Date.now() - start,
    };
  }

  // ── Knowledge gap filling (for dream exploration mode) ──

  /**
   * Fill a knowledge gap by scraping relevant docs.
   *
   * Resolution order:
   *   1. If the gap description contains a URL, use it directly
   *   2. Otherwise, if web search is wired, find an authoritative docs URL
   *   3. Otherwise return `no_url_in_gap_description`
   */
  async fillKnowledgeGap(
    gapDescription: string,
    hints?: {
      category?: string;
      tags?: string[];
      marketplace?: SkillSeekersSource["marketplace"];
      targetId?: string;
    },
  ): Promise<SkillSeekersResult> {
    // Step 1: direct URL extraction
    const urlMatch = gapDescription.match(/https?:\/\/\S+/);
    if (urlMatch) {
      const url = urlMatch[0];
      if (!this.isDomainAllowed(url)) {
        return {
          ok: false,
          envelopes: [],
          ingested: [],
          conflicts: [],
          sourceUrl: url,
          error: "domain_blocked",
          elapsedMs: 0,
        };
      }
      return this.ingestFromSource({
        url,
        name: hints?.category,
        type: "docs",
        marketplace: hints?.marketplace,
        provenance: { gap_description: gapDescription, target_id: hints?.targetId },
      });
    }

    // Step 2: web search fallback
    if (this.config.useWebSearchFallback && this.webSearch) {
      try {
        const url = await this.webSearch.findAuthoritativeUrl(gapDescription, {
          category: hints?.category,
        });
        if (url) {
          if (!this.isDomainAllowed(url)) {
            return {
              ok: false,
              envelopes: [],
              ingested: [],
              conflicts: [],
              sourceUrl: url,
              error: "domain_blocked_via_search",
              elapsedMs: 0,
            };
          }
          return this.ingestFromSource({
            url,
            name: hints?.category,
            type: "docs",
            marketplace: hints?.marketplace,
            provenance: {
              gap_description: gapDescription,
              discovered_via: "web_search",
              target_id: hints?.targetId,
            },
          });
        }
      } catch (err) {
        log.debug(`Web search fallback failed: ${String(err)}`);
      }
    }

    return {
      ok: false,
      envelopes: [],
      ingested: [],
      conflicts: [],
      sourceUrl: "",
      error: "no_url_in_gap_description",
      elapsedMs: 0,
    };
  }

  // ── Marketplace-driven ingestion (PLAN-10 + PLAN-8 Phase 7 closed loop) ──

  /**
   * Generate skills for the top marketplace opportunities that have a
   * known docs URL. Called during dream cycles when MarketplaceIntelligence
   * reports activity — completes the Demand → Skill → Sale loop.
   *
   * Caller supplies a `resolveUrl` callback because URL discovery depends on
   * strategy (curated allowlist, web search, etc.). Return null to skip.
   */
  async ingestFromMarketOpportunities(
    resolveUrl: (category: string) => Promise<string | null> | string | null,
    limit?: number,
  ): Promise<SkillSeekersBatchResult> {
    if (!this.marketplaceIntelligence || !this.config.enableMarketplaceDemand) {
      return { total: 0, succeeded: 0, failed: 0, results: [], elapsedMs: 0 };
    }
    const opportunities = this.marketplaceIntelligence.analyzeOpportunities(
      limit ?? this.config.maxSkillsPerCycle,
    );
    const sources: SkillSeekersSource[] = [];
    for (const opp of opportunities) {
      const url = await Promise.resolve(resolveUrl(opp.category));
      if (!url) {
        continue;
      }
      sources.push({
        url,
        type: "docs",
        name: opp.category,
        marketplace: {
          category: opp.category,
          demandScore: opp.demandScore,
          expectedRevenueUsdc: opp.expectedRevenueUsdc,
        },
        provenance: {
          opportunity: opp.targetDescription,
          readiness_score: opp.readinessScore,
        },
      });
    }
    return this.ingestBatch(sources);
  }

  // ── Internals ──

  private ensureSyntheticPeer(): void {
    try {
      const now = Date.now();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO peer_reputation
           (peer_pubkey, peer_id, skills_received, first_seen_at, last_seen_at,
            is_trusted, reputation_score)
           VALUES (?, ?, 0, ?, ?, 0, 0.5)`,
        )
        .run(this.pubkey, SKILL_SEEKERS_PEER_ID, now, now);
    } catch {
      // Table may not exist yet during early init — that's fine.
    }
  }

  private isDomainAllowed(url: string): boolean {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return false;
    }

    if (this.config.blockedDomains.length > 0) {
      if (this.config.blockedDomains.some((d) => hostname.endsWith(d))) {
        return false;
      }
    }
    if (this.config.allowedDomains.length > 0) {
      return this.config.allowedDomains.some((d) => hostname.endsWith(d));
    }
    return true;
  }

  private processConflicts(conflicts: SkillSeekersConflict[], sourceUrl: string): void {
    if (!this.epistemicDirectiveEngine || conflicts.length === 0) {
      return;
    }

    const highSeverity = conflicts.filter((c) => c.severity === "high");
    // Cap at 2 directives per ingestion to avoid noise
    for (const conflict of highSeverity.slice(0, 2)) {
      try {
        this.epistemicDirectiveEngine.createDirective({
          type: "contradiction",
          question:
            `Conflict detected: ${conflict.apiName} — ${conflict.difference ?? conflict.type}. ${conflict.suggestion ?? ""}`.trim(),
          context: `Source: Skill Seekers conflict detection during ingestion from ${sourceUrl}`,
          priority: 0.8,
        });
      } catch {
        // Skip if directive creation fails
      }
    }
  }
}

// ── Transport probes ──

function probeCliBinary(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], {
      timeout: CLI_VERSION_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function probePythonModule(): boolean {
  try {
    execFileSync("python3", ["-m", "skill_seekers", "--version"], {
      timeout: CLI_VERSION_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

async function probeMcpEndpoint(endpoint: string): Promise<boolean> {
  // Only HTTP(S) endpoints are probed here — stdio MCP would need a separate
  // handshake harness and is left for a future pass.
  if (!/^https?:\/\//.test(endpoint)) {
    return false;
  }
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(CLI_VERSION_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Execution via chosen transport ──

async function runSkillSeekers(
  source: SkillSeekersSource,
  outputDir: string,
  transport: "native" | "mcp" | "cli" | "python",
  mcpEndpoint: string | null,
): Promise<void> {
  if (transport === "native") {
    const result = await runNativeScraper({
      url: source.url,
      name: source.name,
      description: source.description,
      outputDir,
    });
    if (!result.ok) {
      throw new Error(result.error ?? "native_scraper_failed");
    }
    return;
  }
  if (transport === "mcp" && mcpEndpoint) {
    await runSkillSeekersViaMcp(source, outputDir, mcpEndpoint);
    return;
  }
  await runSkillSeekersViaCli(source, outputDir, transport === "python");
}

async function runSkillSeekersViaCli(
  source: SkillSeekersSource,
  outputDir: string,
  pythonModule: boolean,
): Promise<void> {
  const args = ["create", source.url, "--target", "claude", "--output", outputDir, "--quiet"];
  if (source.name) {
    args.push("--name", source.name);
  }
  if (source.description) {
    args.push("--description", source.description);
  }

  const bin = pythonModule ? "python3" : "skill-seekers";
  const fullArgs = pythonModule ? ["-m", "skill_seekers", ...args] : args;
  await execFileAsync(bin, fullArgs, {
    timeout: CLI_RUN_TIMEOUT_MS,
    encoding: "utf8",
  });
}

/**
 * MCP HTTP transport: POSTs a "create" request and writes the returned files
 * into outputDir. Expected response shape:
 *
 *   { files: [{ path: "SKILL.md", content: "..." }, { path: "references/foo.md", ... }] }
 *
 * This matches the shape of the skill-seekers Python CLI's `--json` output
 * and is a thin convention most MCP wrappers already support.
 */
async function runSkillSeekersViaMcp(
  source: SkillSeekersSource,
  outputDir: string,
  endpoint: string,
): Promise<void> {
  const url = `${endpoint.replace(/\/$/, "")}/create`;
  const body = {
    url: source.url,
    target: "claude",
    name: source.name,
    description: source.description,
    type: source.type,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MCP_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`MCP endpoint returned HTTP ${res.status}`);
  }
  const payload = (await res.json()) as {
    files?: Array<{ path: string; content: string }>;
    conflicts?: unknown;
  };
  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    throw new Error("MCP endpoint returned no files");
  }
  // Write payload files into outputDir/<slug>/
  const skillDir = path.join(outputDir, slugForMcp(source));
  fs.mkdirSync(skillDir, { recursive: true });
  for (const file of payload.files) {
    // Prevent path traversal
    const relPath = file.path.replace(/^\/+/, "");
    if (relPath.includes("..")) {
      continue;
    }
    const target = path.join(skillDir, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, "utf8");
  }
  if (payload.conflicts !== undefined) {
    fs.writeFileSync(
      path.join(skillDir, "conflicts.json"),
      JSON.stringify({ conflicts: payload.conflicts }, null, 2),
      "utf8",
    );
  }
}

function slugForMcp(source: SkillSeekersSource): string {
  const base = source.name ?? new URL(source.url).hostname;
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "skill"
  );
}

// ── Output parsing ──

function findSkillDir(outputDir: string): string | null {
  if (!fs.existsSync(outputDir)) {
    return null;
  }

  // Skill Seekers creates output/{name}/ or output/{name}_data/
  // Look for a directory containing SKILL.md
  const entries = fs.readdirSync(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(outputDir, entry.name);
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) {
      return candidate;
    }
  }

  // Maybe SKILL.md is directly in outputDir
  if (fs.existsSync(path.join(outputDir, "SKILL.md"))) {
    return outputDir;
  }

  return null;
}

type ParsedSkill = {
  name: string;
  description: string;
  version: string;
  content: string;
};

function parseSkillDirectory(skillDir: string, source: SkillSeekersSource): ParsedSkill | null {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    return null;
  }

  const skillMd = fs.readFileSync(skillMdPath, "utf8");

  // Parse YAML frontmatter
  const fmMatch = skillMd.match(FRONTMATTER_RE);
  let name = source.name ?? path.basename(skillDir);
  let description = source.description ?? "";
  let version = "1.0.0";

  if (fmMatch) {
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    const verMatch = fm.match(/^version:\s*(.+)$/m);
    if (nameMatch) {
      name = nameMatch[1].trim();
    }
    if (descMatch) {
      description = descMatch[1].trim();
    }
    if (verMatch) {
      version = verMatch[1].trim();
    }
  }

  // Concatenate SKILL.md + all references/*.md
  let content = skillMd;
  const refsDir = path.join(skillDir, "references");
  if (fs.existsSync(refsDir)) {
    const refs = fs
      .readdirSync(refsDir)
      .filter((f) => f.endsWith(".md"))
      .toSorted();
    for (const ref of refs) {
      const refContent = fs.readFileSync(path.join(refsDir, ref), "utf8");
      content += `\n\n---\n\n<!-- reference: ${ref} -->\n\n${refContent}`;
    }
  }

  return { name, description, version, content };
}

function parseConflicts(skillDir: string): SkillSeekersConflict[] {
  // Skill Seekers writes conflicts to conflicts.json in the output dir
  const candidates = [
    path.join(skillDir, "conflicts.json"),
    path.join(skillDir, "..", "conflicts.json"),
    path.join(skillDir, "_data", "conflicts.json"),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const conflicts = raw?.conflicts;
      if (!Array.isArray(conflicts)) {
        continue;
      }
      return conflicts
        .filter(
          (c: Record<string, unknown>) =>
            typeof c.type === "string" &&
            typeof c.severity === "string" &&
            typeof c.api_name === "string",
        )
        .map((c: Record<string, unknown>) => ({
          type: c.type as SkillSeekersConflict["type"],
          severity: c.severity as SkillSeekersConflict["severity"],
          apiName: c.api_name as string,
          difference: (c.difference as string) ?? null,
          suggestion: (c.suggestion as string) ?? null,
        }));
    } catch {
      // skip malformed
    }
  }

  return [];
}

// ── Envelope creation ──

function createEnvelope(
  name: string,
  content: string,
  keypair: SyntheticKeypair,
  opts: {
    category?: string;
    tags?: string[];
    sourceUrl?: string;
    expiresAt?: number;
    provenance?: Record<string, unknown>;
  },
): SkillEnvelope {
  const skillMdBase64 = Buffer.from(content).toString("base64");
  const contentHash = createHash("sha256").update(content).digest("hex");
  const signature = signEnvelope(skillMdBase64, keypair.privateKeyPem);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return {
    version: 1,
    skill_md: skillMdBase64,
    name,
    author_peer_id: SKILL_SEEKERS_PEER_ID,
    author_pubkey: keypair.publicKeyBase64,
    signature,
    timestamp: Date.now(),
    content_hash: contentHash,
    stable_skill_id: `ss:${slug}`,
    skill_version: 1,
    tags: [...(opts.tags ?? []), ...(opts.sourceUrl ? [`source:${opts.sourceUrl}`] : [])],
    category: opts.category,
    expires_at: opts.expiresAt,
    provenance: opts.provenance,
  };
}

// ── Helpers ──

function inferCategory(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("github.com")) {
      return "github";
    }
    if (hostname.includes("docs.") || hostname.includes("documentation")) {
      return "docs";
    }
    if (hostname.includes("api.") || hostname.includes("reference")) {
      return "api";
    }
    return "docs";
  } catch {
    return "docs";
  }
}
