---
summary: How to run and debug the Skill Forge end-to-end pipeline test
read_when:
  - Debugging the skills pipeline (crystallizer, refiner, verifier, marketplace)
  - Running the 9-phase E2E skill forge test
  - Investigating why skills aren't being crystallized or promoted
title: "Skill Forge Debug Guide"
---

# Skill Forge — Debug Guide

## What It Is

The Skill Forge test (`src/memory/scripts/skill-forge-test.ts`) is a **9-phase end-to-end pipeline test** that exercises the full Knowledge Crystal skills lifecycle in isolation. It creates a temporary SQLite database (or copies a live one), seeds data, and runs every stage of the pipeline from task execution through marketplace economics.

## How to Run

```bash
# Standard run (fresh test database)
npx tsx src/memory/scripts/skill-forge-test.ts

# Verbose mode — prints metrics, skill text previews, SKILL.md output
npx tsx src/memory/scripts/skill-forge-test.ts --verbose

# Against a copy of a live database (never modifies the original)
npx tsx src/memory/scripts/skill-forge-test.ts --live path/to/main.sqlite
```

The `--live` flag copies the specified database to a temp file in `os.tmpdir()` before running. The original database is never touched.

Exit code is `0` on all-pass, `1` if any assertion fails.

## What Each Phase Tests

| Phase | Name                     | What It Does                                                                                                                                                                                                                               |
| ----- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | Seed Skill Chunk         | Inserts a realistic task-pattern chunk with embedding, governance JSON, stable_skill_id, and skill metadata into the `chunks` table. Verifies the row exists with correct `semantic_type='task_pattern'`.                                  |
| **2** | Record Execution History | Creates a `SkillExecutionTracker` and records 5 mock executions (4 success, 1 failure = 80% rate). Asserts correct `totalExecutions`, `successRate` (~80%), and `avgRewardScore` (>0.5).                                                   |
| **3** | SkillCrystallizer        | Runs `SkillCrystallizer.crystallizePatterns()` to detect the seeded pattern. Asserts at least 1 new frozen skill crystal is created with `lifecycle='frozen'` and `semantic_type='skill'`.                                                 |
| **4** | SkillRefiner             | Creates a mock `DreamInsight` mutation (enhanced deployment workflow) and runs `SkillRefiner.evaluateMutations()`. Reports the heuristic score and whether the mutation was promoted. Counts total frozen skill crystals after refinement. |
| **5** | SKILL.md Validation      | Generates a SKILL.md document from the best available skill crystal. Asserts YAML frontmatter structure (starts with `---`), presence of `name:` and `description:` fields, document under 500 lines and 20K characters.                   |
| **6** | P2P Ingestion            | Creates a `SkillNetworkBridge` (with null orchestrator) and ingests a simulated peer skill envelope. Asserts the skill is stored in the database. Then re-ingests the same envelope and asserts duplicate rejection.                       |
| **7** | Provenance & Governance  | Inspects the `provenance_chain`, `provenance_dag`, and `governance_json` fields on crystallized skills. Checks that governance scope is `shared`. Reads the `memory_audit_log` for skill-related events.                                   |
| **8** | Marketplace Economics    | Checks marketplace columns (`marketplace_listed`, `download_count`, `steering_reward`) on skill crystals. Runs `MarketplaceEconomics.refreshListings()` and `getEconomicSummary()` to verify the economic layer works.                     |
| **9** | Consolidation Immunity   | Runs `ConsolidationEngine.run()` and asserts that all frozen skill crystals survive decay (frozen crystals are immune to consolidation forgetting).                                                                                        |

## How to Interpret Results

The test prints `PASS` or `FAIL` for each assertion, with a summary at the end:

```
=== RESULTS ===

  Passed: 14
  Failed: 0
  Total:  14

All tests passed! The Knowledge Crystal pipeline is fully operational.
```

Use `--verbose` to see additional detail: execution metrics as JSON, skill text previews, SKILL.md content, and intermediate state.

## Troubleshooting

### Crystallization returns 0 skills

**Symptom:** Phase 3 reports `Crystallized: 0 new skill(s)` and the assertion fails.

**Cause:** The `SkillCrystallizer` requires patterns to meet both:

- `MIN_SUCCESSES = 3` (at least 3 successful executions)
- `MIN_SUCCESS_RATE = 0.7` (at least 70% success rate)

**Check:**

1. Verify Phase 2 actually recorded enough successful executions. The `skill_executions` table must have rows with `success = 1` and `completed_at IS NOT NULL` for the seed skill ID.
2. The crystallizer groups by `skill_crystal_id` — if the seed chunk ID doesn't match the execution records, the query returns nothing.
3. Deduplication: if a frozen skill already exists for that pattern (e.g., from a prior run on a `--live` database), `skillCrystalExists()` returns true and the pattern is skipped.

### Mutation isn't promoted by SkillRefiner

**Symptom:** Phase 4 reports a score below 0.7 and `Promoted: false`.

**Cause:** The `heuristicScore()` function evaluates keyword coverage, length ratio, novelty, and structural indicators. Additionally, `SkillVerifier.verify()` runs a semantic drift check.

**Check:**

1. The heuristic score components: keyword overlap between original and mutation text, length ratio (0.5x-2.0x is good), novelty (new words), and structural patterns (edge case/robustness language).
2. **Cosine distance threshold (0.3):** The verifier rejects mutations with cosine distance > 0.3 from the parent embedding. **Fake embeddings will always fail this check** because `fakeEmbedding()` generates sparse vectors with no semantic relationship. This is expected in test mode — the score gate may pass but verification will reject.
3. The mutation also needs `confidence >= 0.5` to be eligible for promotion.

### P2P ingestion fails

**Symptom:** Phase 6 assertion failure on peer skill ingestion.

**Check:**

1. The `peer_reputation` table must exist (created by `setupTestDb()`).
2. The skill envelope must have a valid `content_hash` matching the SHA-256 of the base64-decoded `skill_md`.
3. If running against a `--live` database with an active cortisol spike, skills from untrusted/provisional peers will be rejected by the cortisol gate.

### Consolidation deletes frozen skills

**Symptom:** Phase 9 reports fewer frozen skills after consolidation.

**Check:** This should never happen — frozen skills are exempt from consolidation decay. If it does, check that the `lifecycle` column is correctly set to `'frozen'` (not `'generated'` or null). The `ConsolidationEngine` skips chunks where `lifecycle = 'frozen'`.

### Database schema errors

**Symptom:** SQLite errors about missing columns or tables.

**Check:** The test calls `ensureMemoryIndexSchema()`, `ensureDreamSchema()`, `ensureCuriositySchema()`, and manually creates `skill_executions`, `peer_reputation`, and `memory_audit_log` tables. If running against a `--live` database from an older version, some columns may be missing. The `ensureColumn()` calls handle most cases, but custom schema additions may need manual migration.
