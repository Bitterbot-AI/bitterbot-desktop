/**
 * Adapter for Skill Seekers (https://github.com/yusufkaraaslan/Skill_Seekers)
 * by Yusuf Karaaslan. MIT License.
 *
 * Converts external documentation sources into Bitterbot SkillEnvelopes via the
 * existing trust/quality pipeline. Skills enter as untrusted (synthetic peer)
 * and are promoted through execution feedback.
 */

import type { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillEnvelope, IngestResult } from "../agents/skills/ingest.js";
import type { BitterbotConfig } from "../config/config.js";
import type { SkillSeekersConfig } from "../config/types.skill-seekers.js";
import { ingestSkill } from "../agents/skills/ingest.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("skill-seekers");

// ── Constants ──

export const SKILL_SEEKERS_PEER_ID = "local-skill-seekers";
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

// Ed25519 SPKI DER prefix for raw 32-byte public keys
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEFAULT_MAX_SKILLS_PER_CYCLE = 3;
const DEFAULT_TTL_DAYS = 30;

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
};

export type SkillSeekersResult = {
  ok: boolean;
  envelopes: SkillEnvelope[];
  ingested: IngestResult[];
  conflicts: SkillSeekersConflict[];
  error?: string;
  sourceUrl: string;
  elapsedMs: number;
};

export type SkillSeekersConflict = {
  type: "missing_in_docs" | "missing_in_code" | "signature_mismatch" | "description_mismatch";
  severity: "low" | "medium" | "high";
  apiName: string;
  difference: string | null;
  suggestion: string | null;
};

// ── Epistemic directive engine interface (lazy-injected) ──

type EpistemicDirectiveEngineLike = {
  createDirective(params: {
    type: "contradiction" | "knowledge_gap" | "low_confidence" | "stale_fact";
    question: string;
    context?: string;
    priority?: number;
    sourceEntityIds?: string[];
  }): unknown;
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
  };
  private epistemicDirectiveEngine: EpistemicDirectiveEngineLike | null = null;
  private bitterbotConfig: BitterbotConfig | null = null;
  private skillsGeneratedThisCycle = 0;
  private available: boolean | null = null;

  constructor(db: DatabaseSync, config?: SkillSeekersConfig) {
    this.db = db;
    this.keypair = loadOrCreateSyntheticKeypair(db);
    this.pubkey = this.keypair.publicKeyBase64;
    this.config = {
      enabled: config?.enabled !== false,
      maxSkillsPerCycle: config?.maxSkillsPerCycle ?? DEFAULT_MAX_SKILLS_PER_CYCLE,
      maxConcurrentScrapes: config?.maxConcurrentScrapes ?? 1,
      allowedDomains: config?.allowedDomains ?? [],
      blockedDomains: config?.blockedDomains ?? [],
      defaultTtlDays: config?.defaultTtlDays ?? DEFAULT_TTL_DAYS,
    };
    this.ensureSyntheticPeer();
  }

  // ── Dependency injection (lazy setters) ──

  setEpistemicDirectiveEngine(engine: EpistemicDirectiveEngineLike | null): void {
    this.epistemicDirectiveEngine = engine;
  }

  setBitterbotConfig(cfg: BitterbotConfig): void {
    this.bitterbotConfig = cfg;
  }

  /** Reset per-cycle counter (call at start of each dream cycle). */
  resetCycleCounter(): void {
    this.skillsGeneratedThisCycle = 0;
  }

  // ── Availability detection ──

  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }
    if (this.available !== null) {
      return this.available;
    }
    this.available = detectSkillSeekersCli();
    if (this.available) {
      log.info("Skill Seekers CLI detected");
    }
    return this.available;
  }

  // ── Core: ingest from URL source ──

  async ingestFromSource(source: SkillSeekersSource): Promise<SkillSeekersResult> {
    const start = Date.now();
    const base: Omit<SkillSeekersResult, "ok" | "envelopes" | "ingested" | "elapsedMs"> = {
      conflicts: [],
      sourceUrl: source.url,
    };

    if (!(await this.isAvailable())) {
      return {
        ...base,
        ok: false,
        envelopes: [],
        ingested: [],
        error: "skill-seekers not installed",
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
      // Run skill-seekers CLI
      const outputDir = path.join(tmpDir, "output");
      runSkillSeekersCli(source, outputDir);

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
        };
      }

      // Parse conflicts if available
      const conflicts = parseConflicts(skillDir);

      // Create SkillEnvelope with valid Ed25519 signature
      const envelope = createEnvelope(parsed.name, parsed.content, this.keypair, {
        category: source.type ?? inferCategory(source.url),
        tags: ["external-generated", "auto-research"],
        sourceUrl: source.url,
      });

      // Ingest through existing pipeline
      const ingested: IngestResult[] = [];
      if (this.bitterbotConfig) {
        const result = await ingestSkill({
          envelope,
          config: this.bitterbotConfig,
        });
        ingested.push(result);
        this.skillsGeneratedThisCycle++;
        log.info(`Skill Seekers ingested "${parsed.name}" from ${source.url}: ${result.action}`);
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

  // ── Knowledge gap filling (for dream exploration mode) ──

  async fillKnowledgeGap(
    gapDescription: string,
    hints?: { category?: string; tags?: string[] },
  ): Promise<SkillSeekersResult> {
    // For knowledge gaps, we use the description as a search query
    // Skill Seekers can take a URL; for gap filling we'd ideally search first.
    // For now, treat the gap as a topic and attempt docs scraping if it looks like a URL,
    // otherwise return gracefully — full web search integration comes in Phase 2.
    const urlMatch = gapDescription.match(/https?:\/\/\S+/);
    if (urlMatch) {
      return this.ingestFromSource({
        url: urlMatch[0],
        name: hints?.category,
        type: "docs",
      });
    }

    // No URL in gap description — can't scrape without a target.
    // Future: integrate with web search to find authoritative docs for the topic.
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

// ── CLI detection ──

function detectSkillSeekersCli(): boolean {
  // Try direct CLI
  try {
    execFileSync("skill-seekers", ["--version"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    // fall through
  }

  // Try as Python module
  try {
    execFileSync("python3", ["-m", "skill_seekers", "--version"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    // fall through
  }

  return false;
}

// ── CLI execution ──

function runSkillSeekersCli(source: SkillSeekersSource, outputDir: string): void {
  const args = ["create", source.url, "--target", "claude", "--output", outputDir, "--quiet"];

  if (source.name) {
    args.push("--name", source.name);
  }
  if (source.description) {
    args.push("--description", source.description);
  }

  // Prefer direct CLI, fall back to python module
  try {
    execFileSync("skill-seekers", args, {
      timeout: 120_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    execFileSync("python3", ["-m", "skill_seekers", ...args], {
      timeout: 120_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
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
  opts: { category?: string; tags?: string[]; sourceUrl?: string },
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
