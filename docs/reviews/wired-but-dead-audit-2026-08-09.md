# Wired-But-Dead Feature Audit — 2026-08-09

**Method:** 12 parallel subsystem auditors armed with the 10 defect patterns from the 2026-08-08/09 live-testing campaign, each finding adversarially refuted (a second agent tried to find the production caller; test files don't count as proof of life), then synthesized. 73 agents, ~4.4M tokens. **57 claims survived refutation, 3 refuted.** 17 ranked findings after dedup, all HIGH confidence.

**Headline:** the entire **skills economy and curiosity loop are structurally dead end-to-end**, not in one place but as connected chains. Skills are generated but mis-categorized at birth, never auto-propagate, never earn peer trust when received, and per-skill telemetry always reads zero. The curiosity engine generates targets but has never resolved a single one. None of this throws an error; it all silently no-ops.

Every finding below names an artifact-based live test (DB/log/file assertion, never the agent's prose). The full test battery is in §Test Battery.

---

## Ranked findings

### Tier 1 — active, user-facing, fix now

**F1 — Stale orchestrator binary: the whole per-circle mesh transport is dead + a 10s stall on every circle send.** `src/infra/orchestrator-bridge.ts:318`
The deployed release binary (built Jul 4) predates the `subscribe_topic`/`publish_topic` IPC handlers. `src/circles/service.ts:726` awaits `publishCircleFrame` _before_ direct-dial fan-out, so every circle message burns the full 10s `DEFAULT_IPC_TIMEOUT_MS` before falling back. This is the canary for a whole **deploy-drift class**: the running Rust binary is 5 weeks behind `orchestrator/src`. (This is the source of yesterday's `Unknown IPC message type` WARNs.)
_Fix:_ `cargo build --release --manifest-path orchestrator/Cargo.toml` + orchestrator restart. Also a design gap: the Rust IPC layer returns success-without-reply on unknown types, so every future schema drift manifests as a silent 10s timeout — it should NAK unknown types.

**F2 — `after_tool_call` fires twice per tool call.** `src/agents/pi-tool-definition-adapter.ts:118` + `src/agents/pi-embedded-subscribe.handlers.tools.ts:330`
Both the adapter's `execute()` and the subscribe tool-end handler run the global hook chain. Every skill execution is recorded 2×, `steering_reward` is +0.2 instead of +0.1, and hormonal reward/error stimulation is doubled on **every tool call fleet-wide**. Corrupts all execution telemetry and biases the hormonal system continuously. (The existing 10 `skill_executions` rows are 5 doubled pairs — one row per pair has NULL `execution_time_ms`.)

**F3 — Skill bootstrap read the wrong directory, then latched permanently.** `src/memory/seed-crystal-migration.ts:177`
`runSkillBootstrap` reads `<workspaceDir>/skills` (ENOENT) instead of `CONFIG_DIR/skills` (the real root per `skill-storage.ts:72`). It inserted 0 crystals, then set `skill_bootstrap_done=true` forever. Result: all 516+ skill crystals have `skill_category` NULL permanently, and new crystals inherit NULL. **This is the root cause of F12.** The once-only latch means it can never self-heal.

**F4 — 3 of 4 builtin interceptors bind to nonexistent tool names.** `src/agents/skills/builtin-interceptors/calibrate-claim-confidence.ts:30` (+ `protocol-quiet-in-groups.ts:13`, `recall-before-claim.ts`)
They target `send_message`/`discord_send`; the real tools are `message`/`sessions_send`. Exact-match registry → they can NEVER activate → `intervention_records` has 0 rows ever. **Root cause of F13.** Kills the entire PLAN-20 executable-guard value chain. (Ironically `interceptor-runner.ts:38` already knows the correct `^message$` pattern.)

### Tier 2 — the skills economy is structurally dead

**F5 — Automatic skill propagation dead since the maturity gate (Aug 3).** `src/memory/skill-network-bridge.ts:397`
`publishCrystalSkill` only fires at crystallization time, when executions=0 by construction, but the gate needs ≥3 executions — and nothing ever re-attempts publish once a skill matures. All 76 `published_at` rows are from the pre-gate Aug-3 mass publish; 286 crystals created since, 0 published. (Fix F2 first — doubled executions would make the ≥3 gate pass at ~2 real executions.)

**F6 — Peer trust can never graduate.** `src/agents/skills/ingest.ts:325`
`acceptIncomingSkill` never calls `recordIngestionResult`, and the only accept-credit site requires already-`trusted`/`verified` status — a chicken-and-egg. Live DB: 42 peers, top peer `skills_received=125`, `skills_accepted=0` for ALL, every `reputation_score` at 0.5 or decayed. Sub-bug: `manager.ts:2239` selects `pubkey` instead of `peer_pubkey` (no-such-column, silently swallowed → `updatePeerQuality` has never run).

**F7 — EigenTrust is write-only.** `src/memory/manager.ts:2231`
Scores are computed and persisted every consolidation tick but never read into any trust decision (the sole reader is behind a never-taken branch; even the Rust gossipsub score injection at `swarm/mod.rs:1741` is dead). 42 peers have `eigentrust_score` populated influencing nothing.

**F10 — Revenue split can never pay a real peer.** `src/memory/marketplace-economics.ts:359`
`computeRevenueShares` treats `provenance_chain` entries (crystal UUIDs) as peer wallet recipients. Latent only because `marketplace_purchases=0`, but becomes a silent money-black-hole on the first real x402 sale (caller live at `a2a-http.ts:614`). Also `peer_reputation` has no `wallet_address` column — the wallet resolver throws unconditionally.

**F11 — Network skill versioning dead on the wire.** `orchestrator/src/crypto.rs:96`
The TS→Rust publish path hardcodes `stable_skill_id`/`skill_version`/`previous_content_hash`/tags/category to None, so the receiving-side version-conflict resolution (`skill-network-bridge.ts:483`) is dead weight; all 323 peer-origin chunks have `lineage_hash` NULL.

**F12 — `skills.metrics` gateway surface permanently empty.** `src/memory/skill-execution-tracker.ts:186`
Joins `skill_executions` to `chunks` on `skill_category`, which F3 left NULL. Per-skill telemetry reads zero despite recorded executions. Pure consequence of F3.

**F13 — `interceptor_harvest` dream mode is a guaranteed no-op.** `src/memory/dream-modes/interceptor-harvest.ts:115`
Mines `intervention_records` (0 rows per F4). Runs on schedule, produces nothing, wastes cloud-tier LLM cycles. Auto-heals once F4 lands.

**F14 — Phase 5B execution-verification trust loop is dead code.** `src/memory/peer-reputation.ts:1083`
`recordSkillExecutionVerification`, `rateSkill`, `recordCategoryTrust`, `recordPeerAnomalyReport` have no production callers (`peer_category_reputation` table never created). Third leg of the dead trust triad with F6/F7.

**F15 — Self-loopback guard unreachable.** `src/agents/skills/ingest.ts:104`
`server-startup.ts:286` omits `ownPublishPubkey`, so a node quarantines its own re-broadcast skills (quarantine dir already contains own "Dream-generated skill crystal" entries).

**F16 — Quarantine notification names a phantom RPC method.** `src/agents/skills/ingest.ts:290` (+ `workspace.ts:85`)
Tells the operator to run `skills.quarantine.list`, which doesn't exist (real: `skills.incoming.list`). Misleads at exactly the moment F6's manual review depends on them. 2-line fix.

### Tier 3 — the curiosity loop never closes

**F8 — Curiosity regions get fresh UUIDs every consolidation cycle.** `src/memory/curiosity-engine.ts:1121`
`rebuildRegions` DELETEs all `curiosity_regions` and reinserts with new random UUIDs every ~30 min → `learning_progress` permanently 0, `curiosity_progress` accumulates 607 orphaned rows keyed to dead region ids. Breaks the documented GCCRF retirement contract.

**F9 — Zero curiosity targets have ever been resolved.** `src/memory/curiosity-engine.ts:637`
`region_id` is always NULL for `knowledge_gap` resolution, and the GC path only deletes rows that already have `resolved_at` set — which never happens. Expiry-only lifecycle: the loop generates targets but never closes them. (Absence-proof is strong: resolved rows are never deleted, and there are none.)

**F17 — `recordSearchSurprise` has zero callers anywhere.** `src/memory/curiosity-engine.ts:749`
The entire search-prediction-error curiosity signal was designed and never wired. Lowest urgency (no corruption, no user symptom).

---

## Quick fixes (fix smaller than the test)

| Finding    | Fix                                                                                               | LOC |
| ---------- | ------------------------------------------------------------------------------------------------- | --- |
| F16        | `skills.quarantine.list` → `skills.incoming.list` at ingest.ts:290 + workspace.ts:85              | 2   |
| F6 sub-bug | manager.ts:2239 `pubkey` → `peer_pubkey` (unblocks `updatePeerQuality`)                           | 1   |
| F7 sub-bug | manager.ts:2231 pass the real orchestrator bridge into `refreshEigenTrustScores`                  | ~2  |
| F15        | server-startup.ts:286 pass `ownPublishPubkey` into `ingestSkill`                                  | 2   |
| F4         | Replace phantom `MESSAGE_TOOLS` lists with `['message','sessions_send']` (3 files)                | ~6  |
| F3         | Resolve skills dir from CONFIG_DIR + one-time latch clear                                         | ~5  |
| F6 main    | Thread reputationManager + author pubkey into `acceptIncomingSkill`, call `recordIngestionResult` | ~15 |
| F2         | Suppress adapter-side `runAfterToolCall` when the subscribe tool-end handler is active            | ~10 |
| F1         | `cargo build --release` orchestrator + restart (deploy, not code)                                 | 0   |

---

## Test battery

**Conventions:** every assertion is an artifact (DB row, log line, file, RPC error), never the agent's prose. CLI agent turns use `node scripts/run-node.mjs agent --to +15550009999 --json -m "..."`. DB reads are `node:sqlite` readOnly against `~/.bitterbot/memory/main.sqlite` and `~/.bitterbot/tasks.sqlite`.

**Recommended order:** A1 first (free, snapshots the full defect baseline for diffing) → A2/A3 (justify the orchestrator rebuild) → rest of A → apply quick fixes → group B as acceptance tests → group C as 48h standing observation targets (consider a daily cron that re-runs A1 and diffs).

### Group A — no restart, run against the live gateway now

- **A1** Read-only SQL invariant battery (one script, covers F2/F3/F4/F5/F6/F7/F8/F9/F12/F13/F14): asserts `skill_bootstrap_done='true'` with 0 bootstrap chunks; all `skill_category` NULL; `intervention_records=0`; `skills_accepted=0` across peers; 0 resolved curiosity targets; `published_at` all pre-Aug-3; doubled-execution pairs. **This is the baseline snapshot.**
- **A2** Orchestrator IPC probe + `strings | grep -c subscribe_topic` = 0 (F1)
- **A3** Circle-send latency probe — ≥10s stall before fan-out (F1 impact)
- **A4** `gateway call skills.metrics` returns empty vs recorded executions (F12)
- **A5** `gateway call skills.quarantine.list` → unknown-method error; `skills.incoming.list` works (F16)
- **A6** Interceptor candidate resolution: `candidatesFor('message')`=0, `candidatesFor('send_message')`=3 (F4)
- **A7** `computeRevenueShares` on a DB copy → recipient is a crystal UUID, not a wallet (F10)
- **A8** Dead-caller grep battery for `ownPublishPubkey`/`recordSearchSurprise`/`rateSkill`/etc across src+dist (F15/F17/F14)

### Group B — needs seeded data or config (acceptance tests for the fixes)

- **B1** Bootstrap rerun on DB copy after latch clear → bootstrap chunks >0, categories = folder names (F3 accept)
- **B2** Quarantine-accept carries no trust credit (F6) — seed fake pubkey + cleanup
- **B3** `interceptor_harvest` logic-vs-starvation isolation on scratch DB (F13)
- **B4** Double-fire drive: one tool-invoking turn → exactly one row post-fix (F2 accept)
- **B5** Execution-feedback drive using an accepted skill (F14)
- **B6** Post-fix interceptor activation: confident group message → `intervention_records`>0 (F4 accept)

### Group C — two-node / long-horizon observation targets

- **C1** Region UUID turnover across 2 consolidation ticks (~1h) (F8)
- **C2** EigenTrust write-only across one tick (~30min) (F7)
- **C3** Propagation never retries at maturity (48h; sentinel crystal `9bbcdfbf-7bef`, 6/6 executions) (F5)
- **C4** Expiry-only target lifecycle (48h) (F9)
- **C5** Network versioning null-on-wire (two-node or passive peer) (F11)
- **C6** Self-loopback quarantine watch (passive) (F15)

---

## Refuted (did NOT survive — noted for honesty)

- Propagation gate vs marketplace listing gate use different metric semantics → refuter found the shared listing-candidate path (`marketplace-economics.ts:172`).
- `assessChunk` never executed → refuter cited 8,645 rows, **but in the pre-fresh-start backup DB only** (weak; see coverage gaps).
- `forage.review/reviewRelease` have no callers → refuted only by the generic `gateway call` escape hatch (weak; no purpose-built operator surface exists).

---

## Fix status (updated 2026-08-09)

**Landed with tests** (commits 34f78cd, 8c5e4ff, fd59b1a): F2, F3, F4, F6, F8, F16. The A1 baseline confirmed every finding against live data first; after deploy, F3 verified live (4 disk skills now categorized, `skill_category` non-NULL for the first time).

**F12 only PARTIALLY fixed (live-verified 2026-08-09):** F3's bootstrap fix categorizes the 4 on-disk skills, but the 521 pre-existing skill crystals (193 `model=dream`, 328 `model=peer`) still have NULL `skill_category` — they are created by the crystallizer / received-skill path (`skill-crystallizer.ts:197`, `skill-refiner.ts:355`, the P2P ingest path), not the bootstrap. `skills.metrics` now returns rows for disk skills but stays empty for those 521. **Remaining F12 work:** (a) have the crystallizer set `skill_category` on new crystals, (b) backfill the existing 521 NULL categories. Flagged here rather than silently over-claimed.

**F12 remaining half CLOSED (2026-08-10):** the count had grown 521 → 584 while unfixed (the leak was live). New `src/memory/skill-category.ts` is the single derivation point for the canonical skill key: frontmatter `name:` (stripping the forage `response-<8hex>-` prefix so responses group under their skill) → parent-chain inheritance → `stable_skill_id` / path basename. All three creation paths now set `skill_category` at insert time (`skill-network-bridge.ts` ingest, `mem-store.ts` `importFromPeer`, `skill-refiner.ts` mutation crystals — the refiner also derives when its original is uncategorized instead of copying NULL). Migration **v57** heals existing rows; dry-run against a copy of the live DB: 584/584 backfilled, 0 unresolved, 43 distinct categories (top: `skill-f5e70aa9-…` ×218). Fills NULLs only, never rewrites — N-1 safe.

**F4 verified structurally** (binding test: `candidatesFor('message')` now returns the interceptors); `intervention_records` will grow on the next confident-claim message turn (Group B6, needs live activity — not visible in a cold A1 snapshot).

**C1 live acceptance PASSED (2026-08-10):** all 3 curiosity region UUIDs survived a consolidation rebuild ~1.5h (and two gateway restarts) after the baseline snapshot — region identity is stable (F8 holds live), and `learning_progress` is accumulating non-zero values for the first time (e.g. `user-querying-robust` lp=1.5e-4, previously permanently 0).

**F1 DEPLOYED (2026-08-10):** orchestrator rebuilt from source (1m24s) and running on both subsequent boots; zero `Unknown IPC message type` warns and `circle topic transport active` logged — `subscribe_topic` completes over IPC, so the 10s stall before circle fan-out is gone. Gotcha for A2: `strings | grep -c subscribe_topic` reads 0 on release builds because the linker merges string literals (the `unsubscribe_topi` cluster is the tell) — probe the log line, not the binary strings.

**F5 FIXED (2026-08-10):** the execution-tracking hook now fires a matured-unpublished callback the moment a skill crosses the ≥3-completed-execution gate with `published_at` NULL — execution-recording is the only moment a crystal can cross the gate, so that is where the re-attempt lives. The manager wires it to `publishCrystalSkill`, which re-runs the full gate chain (governance, provenance, verifier, maturity) and no-ops without an orchestrator bridge, so over-calling is safe. The one currently-stuck matured skill will publish on its next successful execution.

**B6/B4 live acceptance PASSED (2026-08-10):** drove the real agent to send a confidently-phrased factual message via the `message` tool. `recall-before-claim:default` fired and blocked the ungrounded send — `intervention_records` grew 0 → 3 (first rows EVER; full hormonal/GCCRF state snapshots captured). `skill_executions` grew 10 → 13 with zero new doubled pairs (F2 double-fire fix holds under live traffic). Two observations for the follow-up queue: (1) plain agent replies never traverse the `message` tool, so interceptors only guard _outbound_ sends the agent initiates — by design, but worth stating; (2) `recall-before-claim`'s prereq loops when the claim is common knowledge with nothing in memory to ground ("ground the assertion \"Water\"" re-fired 3× until the agent gave up) — it needs an escape hatch (e.g. one grounding attempt then pass-with-hedge), a behavioral design choice, not a quick fix. Notably the agent twice REFUSED to send fabricated confident claims before the interceptor was ever reached — the epistemic layer upstream is doing real work.

**Deferred — need a design decision, not a quick fix:**

- **F7 (eigentrust read-into-decision).** The quick "pass the bridge" line is insufficient: the real defect is that no trust decision _reads_ `eigentrust_score`, and the manager passes `this.skillNetworkBridge ? undefined : null` so scores never route to the Rust orchestrator either. Making auto-accept of peer code depend on eigentrust is security-sensitive and needs the read path designed deliberately (which decision consumes the score, what threshold, how it composes with the existing reputation_score). Do not band-aid. F6's accept-credit fix is the prerequisite (it starts populating the trust signal eigentrust would consume).
- **F9 (curiosity target resolution).** F8 fixed region _identity_ (the prerequisite). Resolution still needs semantics designed: what event marks a `knowledge_gap` resolved (a successful exploration dream? a deep_recall that finally answers it?), and the `region_id` must be set on targets at creation (currently always NULL). Tractable but a behavioral design choice.
- **F15 (self-loopback guard).** Needs the node's own publish pubkey, which lives in the Rust signer and is not cleanly available at the `ingestSkill` call site. Lowest value (quarantine noise). Wire only once the publish pubkey is surfaced to the gateway (would also help F7).

## Coverage gaps (not audited — next round)

1. **Marketplace BUY side end-to-end** — `marketplace_purchases=0` means the entire x402-sale → revenue-queue → `releaseHeldPayments` → on-chain USDC send path has _never run_; likely hides more dead wires (and `peer_reputation` has no `wallet_address` column).
2. **`recordUsage` dead wire** starving the PLAN-15 curator (flagged in healthy-paths notes, no finding covers it).
3. **Hormone → behavior modulation chain** — F2 proves double-dosing but the effect size on actual decisions is unquantified.
4. **`curiosity_surprises` post-fresh-start liveness** — the refutation used pre-July-15 backup data; re-check on the live DB.
5. **Dream modes beyond the four sampled** — relationship_mining, harness_evolve, canonical_promotion (PLAN-33 auto-pinning still "live verification outstanding").
6. **Circles beyond the transport leg** — consent chain, signed ledger fold/freeze, mailbox delivery correctness.
7. **Rust orchestrator internals** — gossipsub peering health, relay-fleet utilization, the NAK-on-unknown-IPC design gap.
8. **Deploy-drift as a class** — a "build provenance" check (mtimes + symbol markers across all deployed binaries/bundles) would close the class F1 caught by accident.
9. **Task spine + recall subsystems** (PLAN-16/17, proactive recall, SABM, PLAN-27/28 extraction throughput) — high-prior given prior wired-but-dead history.
10. **~7.3k fact crystals with empty `[]` embeddings and no re-embed path** (known-OPEN, unaudited).
