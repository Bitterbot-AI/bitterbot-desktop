#!/usr/bin/env node
/**
 * Smoke test for the Skill Seekers native scraper + ingestion pipeline.
 *
 * Exercises the full path in a temporary state dir so it doesn't pollute
 * your real ~/.bitterbot:
 *
 *   1. Instantiate a fresh DB in a temp dir
 *   2. Build the adapter
 *   3. Scrape a small public docs page via the native transport
 *   4. Run it through ingestSkill with policy="review" (quarantine)
 *   5. Inspect the quarantined output and print the envelope
 *
 * Usage:  npx tsx scripts/test-skill-seekers-native.mjs [url]
 * Default URL: https://docs.python.org/3/tutorial/introduction.html
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const url = process.argv[2] ?? "https://docs.python.org/3/tutorial/introduction.html";

// Isolate state so this script never touches the user's real config dir.
const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "ss-smoke-"));
process.env.BITTERBOT_STATE_DIR = tmpState;
process.env.BITTERBOT_CONFIG_DIR = tmpState;
process.env.HOME = tmpState;

console.log(`\n── Skill Seekers smoke test ──`);
console.log(`URL:       ${url}`);
console.log(`State dir: ${tmpState}`);
console.log("");

// Dynamic import AFTER env vars are set, so CONFIG_DIR resolves to the tmp.
const { SkillSeekersAdapter } = await import(
  path.join(repoRoot, "src", "memory", "skill-seekers-adapter.ts")
);

// Build minimal DB schema the adapter needs.
const db = new DatabaseSync(path.join(tmpState, "memory.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS peer_reputation (
    peer_pubkey TEXT PRIMARY KEY,
    peer_id TEXT,
    skills_received INTEGER DEFAULT 0,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    is_trusted INTEGER DEFAULT 0,
    reputation_score REAL DEFAULT 0.5
  );
`);

// Minimal config — ingestPolicy=review so we can see what got written.
const cfg = {
  skills: {
    p2p: {
      ingestPolicy: "review",
    },
    skillSeekers: {
      enabled: true,
      maxSkillsPerCycle: 5,
      defaultTtlDays: 30,
    },
  },
};

const adapter = new SkillSeekersAdapter(db, cfg.skills.skillSeekers);
adapter.setBitterbotConfig(cfg);

console.log("Step 1: Checking availability...");
const available = await adapter.isAvailable();
console.log(`  available: ${available}`);
if (!available) {
  console.error("  ✗ Adapter not available — aborting.");
  process.exit(1);
}

console.log(`\nStep 2: Scraping ${url}...`);
const t0 = Date.now();
const result = await adapter.ingestFromSource({ url, type: "docs" });
const elapsed = Date.now() - t0;

console.log(`  elapsed:    ${elapsed}ms`);
console.log(`  ok:         ${result.ok}`);
console.log(`  transport:  ${result.transport}`);
console.log(`  error:      ${result.error ?? "(none)"}`);
console.log(`  envelopes:  ${result.envelopes.length}`);
console.log(`  ingested:   ${result.ingested.length}`);
for (const r of result.ingested) {
  console.log(`    action=${r.action}  name=${r.skillName}  path=${r.skillPath ?? "(none)"}`);
}

if (!result.ok || result.envelopes.length === 0) {
  console.error("\n  ✗ Scrape failed. See error above.");
  fs.rmSync(tmpState, { recursive: true, force: true });
  process.exit(1);
}

console.log(`\nStep 3: Inspecting the envelope...`);
const env = result.envelopes[0];
console.log(`  name:              ${env.name}`);
console.log(`  author_peer_id:    ${env.author_peer_id}`);
console.log(`  author_pubkey:     ${env.author_pubkey.slice(0, 24)}...`);
console.log(`  signature:         ${env.signature.slice(0, 24)}...`);
console.log(`  content_hash:      ${env.content_hash.slice(0, 24)}...`);
console.log(`  stable_skill_id:   ${env.stable_skill_id}`);
console.log(`  category:          ${env.category}`);
console.log(`  tags:              ${JSON.stringify(env.tags)}`);
if (env.expires_at) {
  console.log(`  expires_at:        ${new Date(env.expires_at).toISOString()}`);
}
if (env.provenance) {
  console.log(
    `  provenance:        ${JSON.stringify(env.provenance, null, 2).split("\n").join("\n                     ")}`,
  );
}

console.log(`\nStep 4: Checking the filesystem...`);
const quarantineDir = path.join(tmpState, "skills-incoming");
if (fs.existsSync(quarantineDir)) {
  const skills = fs.readdirSync(quarantineDir);
  console.log(`  quarantine dir:  ${quarantineDir}`);
  console.log(`  skills found:    ${skills.length}`);
  for (const skill of skills) {
    const skillDir = path.join(quarantineDir, skill);
    const entries = fs.readdirSync(skillDir);
    console.log(`    ${skill}/`);
    for (const e of entries) {
      const stat = fs.statSync(path.join(skillDir, e));
      console.log(`      ${e}  (${stat.size} bytes)`);
    }
    const skillMd = path.join(skillDir, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      console.log(`\n  ── SKILL.md (first 25 lines) ──`);
      const lines = fs.readFileSync(skillMd, "utf8").split("\n").slice(0, 25);
      for (const line of lines) {
        console.log(`    ${line}`);
      }
    }
  }
} else {
  console.error(`  ✗ No quarantine dir at ${quarantineDir} — something swallowed the skill.`);
}

console.log(`\nStep 5: Cleanup`);
fs.rmSync(tmpState, { recursive: true, force: true });
console.log(`  removed ${tmpState}`);
console.log(`\n✓ Smoke test complete.\n`);
