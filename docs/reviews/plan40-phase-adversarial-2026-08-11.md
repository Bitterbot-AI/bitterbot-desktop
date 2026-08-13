# PLAN-40 Phases 1-3 — adversarial pass (2026-08-11)

The pass the standing rule owed after Phases 0-3 shipped fast. One reviewer per
phase, read-only, every claim backed by `file:line` or a read-only query against
the live memory DB (schema v59). This document is the ledger; the scorecard
(`plan40-scorecard-2026-08-10.md`) records what was claimed, this records what
survived scrutiny.

**Headline: the three lanes are in worse shape than the scorecard suggests.**
Lane 2 (hygiene) does not durably shrink the retrieval surface and in the
session-sourced case increases duplication. Lane 1 (distillation) cannot produce
a single qualifying row in production. Lane 3 (anticipation) had an owner gate
that was a no-op. Two of the three pre-registered pilots (D1, D2) cannot be
scored on this build; D3 is unfalsifiable as instrumented.

Fixed in this commit: the Lane 3 owner gate (P3-F1/F2) and the interceptor
session-key chain that the pass turned up alongside it. Everything else is
recorded here as a ranked backlog with no code change.

## Fixed here

### P3-F1/F2 — the Lane 3 owner gate never gated anything (CRITICAL)

Briefs are cross-session synthesis of the owner's private context. The gate read:

```ts
const dmPeer = /:dm:([^:]+)$/.exec(sessionKeyForOwner)?.[1];
const ownerTurn = liveUserTurn && (dmPeer === undefined || ownerNumbers.some(...));
```

**No session key in this product ever contains `:dm:`.** DM keys use `direct:`
(`src/routing/session-key.ts:150-185`), and under the default
`session.dmScope="main"` a DM from _anyone_ collapses to the owner's canonical
main key with no peer segment at all. So `dmPeer` was always `undefined`, the
`ownerNumbers` branch was dead code, and the gate degraded to exactly the
`first_party` trust check PLAN-40 §7 rejected — a stranger's DM classifies
`first_party` under the token-denylist classifier.

Latent, not live: the node currently has no messaging channel configured. It
fires the moment one is onboarded with an open DM policy.

The correct signal was already on the same params object and already consumed
180 lines earlier for owner-only tool policy: `params.senderIsOwner`, computed
from real sender matching in `command-auth.ts` and false when no owner allowlist
is configured. The fix (`resolveBriefOwnerTurn` in `research-findings-block.ts`,
one definition used by both drain sites) accepts two proofs of owner:

- `senderIsOwner === true` — a real sender matched the owner allowlist; or
- no external channel carried the turn (empty provider, or the internal
  `webchat` provider used by the Control UI). Every real messaging channel sets
  `Provider` on inbound context, so a channel turn can never take this branch.

This fails **closed** for channel traffic on an unconfigured node. The CLI path
keeps working because `commands/agent.ts` passes `senderIsOwner: true` for local
drives; a channel session routed to a CLI _backend_ now correctly does not.

Test: a six-case table in `research-findings-block.test.ts` including the
negative case the scorecard listed as unproven (stranger DM refused), plus
drain/no-drain assertions on the brief queue.

### Interceptor session keys — every record written under `__anon__`

Not a PLAN-40 item; found while verifying the outcome-backfill tagger (the sole
gate on `interceptor_harvest`'s wake, which needs >=10 tagged records).
`intervention_records` held 3 rows, all `session_key='__anon__'`, all
`outcome_tag IS NULL`. Three independent breaks:

1. **The marker is erased on every real run.** `wrapToolWithBeforeToolCallHook`
   tags its output with a non-enumerable symbol. `wrapToolWithCapabilityEnforcer`,
   `wrapToolWithAbortSignal` and `wrapToolWithCache` all rebuild the tool with
   `{ ...tool }`, and object spread does not copy non-enumerable symbols. The
   abort wrapper is unconditional in the embedded runner, so the tag never
   survived. `toToolDefinitions` then believed the tool was unwrapped and ran the
   hook itself **without ctx** — hence `__anon__`, and hence every interceptor
   evaluated twice per tool call. Fixed with `carryToolMarkers`
   (`pi-tools.types.ts`), applied in all three wrappers, with a test that stacks
   them in the order `pi-tools.ts` applies them.
2. **Key skew.** `chat.send` called the backfill with the raw RPC param while the
   runner stamped records with the canonical, lowercased key. A client sending
   `"main"` wrote turns under `main` and records under `agent:main:main`. Both
   the backfill and the session-context tracker now use the canonical key.
3. **The CLI path never called the backfill at all.** `server-methods/agent.ts`
   — the RPC behind `bitterbot agent --to`, i.e. how live drives are done — had
   neither call. Added.

## Backlog — not fixed, ranked

Severity is "what it costs if left alone", not effort.

### Lane 2 / hygiene (Phase 1)

1. **P1-F1 (CRITICAL) — the merge is undone by ordinary re-indexing.**
   `manager-embedding-ops.ts:851-854` deletes chunks by `(path, source)` and
   `:908-930` re-inserts them with `lifecycle='generated'`, `parent_id=NULL`,
   `hygiene_done=0` and fresh vec+FTS rows. Every merge member so far is
   `source='sessions'`, the most frequently re-indexed source. Live: 10 merge
   summaries, **6 with zero surviving member links**; one member was demoted at
   22:56 and resurrected 14h later. Two summaries already cover the same
   material. This resolves the scorecard's open observation #1 — it is not
   "re-sync rewriting rows", it is delete-and-reinsert erasing the demotion.
   **D2 cannot be scored on this build.**
2. **P1-F2 (CRITICAL) — `compression` archives hygiene summaries and repoints
   `parent_id` at a `dream_insights` id** (`dream-engine.ts:2095-2110`), the E8
   anti-pattern the plan forbids. Live: one summary is `lifecycle='archived'`
   (in no retrieval lifecycle list) with a parent id that no longer exists in
   `dream_insights`. Its cluster's content is now retrievable from nowhere and
   its rollback pointer dangles.
3. **P1-F3 (HIGH) — "one transaction, rolls back wholly" does not hold.** Each
   index mutation inside the transaction is individually `catch {}`-swallowed
   with no log (`manager.ts:5517-5526`, `:5545-5556`), so a half-applied merge
   commits. Live: 12 of 20 demoted members still have `chunks_fts` rows
   alongside their summaries — doubly keyword-retrievable.
4. **P1-F4 (HIGH) — a summary can commit with no vector row while members' vec
   rows are deleted** (`manager.ts:5489-5495`): embed failure is swallowed and
   demotion proceeds anyway. Ordering was implemented; the precondition was not.
5. **P1-F5 (HIGH) — hygiene funnel rows are structurally unconsumable.** The
   summary INSERT omits `origin`, so summaries are `origin='indexed'`, and the
   only `retrieved` stamp site collects ids solely inside the `origin === "dream"`
   branch (`proactive-recall.ts:644-654`). All 10 hygiene rows in `dream_utility`
   have `first_consumed_at IS NULL` and no code path can ever stamp them.
6. **P1-F6 (MEDIUM) — the rollback script does not exist.** §5.2 and §9 claim a
   "documented, tested" re-index recovery script; there is none.
7. **P1-F7 (MEDIUM) — `staleness_asked_count` is never reset**, so the 3-ask
   budget is lifetime. After three asks a fact flips to `unconfirmed` without
   ever being asked again. `identity.user.name` and `relationship.spouse.name`
   are first in the queue and go stale ~2026-10-14.
8. **P1-F8/F9/F10/F11 (MEDIUM-LOW)** — backfill predicate differs from both the
   spec and the doctor's acceptance metric (a chunk with `embedding IS NULL` is
   never selected); poison-row tail can livelock the backfill; the candidate
   query accepts `lifecycle='consolidated'` rows the spec forbids;
   `BEGIN`/`ROLLBACK` is not nesting-safe.

### Lane 1 / distillation (Phase 2)

1. **P2-F1 (CRITICAL) — the lane cannot produce a qualifying row, ever.** The
   recorder matches `skill_category = <toolName>` (`execution-tracking-hook.ts:74-85`),
   but `skill_category` comes from a skill document's frontmatter name, never a
   tool name. Live: all 13 `skill_executions` rows have `recorded_by IS NULL`
   and `tool_name IS NULL`; **zero rows written since v58 deployed**; rows
   passing the lane's fence: 0. D1 is not "waiting on volume", it is starved by
   construction. The unit test hides this by fabricating
   `skill_category='web-search'` against tool `web_search`.
2. **P2-F2 (CRITICAL) — Lane 1 products have no reachable consumption path.**
   `writeWorkflowNoteChunk` never sets `epistemic_layer`, and both proactive-recall
   candidate queries require `epistemic_layer IN ('directive','world_fact','mental_model')`.
   D1's second kill criterion ("zero consumption stamps") therefore fires
   regardless of quality.
3. **P2-F3 (CRITICAL) — every workflow note is expired by the skill sync and can
   never regenerate.** `cleanupOrphanedSkillChunks` expires
   `semantic_type IN ('skill','task_pattern')` rows whose `path` is missing on
   disk; notes use a synthetic path (`distill/workflow/<id>`) that never exists.
   The lane's idempotency guard then finds the tombstone and skips forever.
4. **P2-F4 (HIGH) — the success gate degrades to "3 tool calls that didn't
   throw".** No Judge/verifier leg exists; `recordFeedback` has zero production
   callers so `user_feedback` is always NULL; `success` is `!event.error`.
5. **P2-F5/F6/F7/F8 (MEDIUM)** — the "<=2 LLM calls/cycle" cap counts notes
   produced, not calls spent (a cycle can spend the whole shared budget); the
   cursor advances past the candidate that triggers the break, starving it; no
   lifecycle fence on lane inputs (a deleted skill can mint a permanent note);
   D1's denominator ("selected cycles with qualifying fuel") is not recorded
   anywhere and 7 such cycles have already run unlogged.
6. **P2-F11** — scorecard deviation #3 is factually wrong: workflow notes cannot
   reach proactive recall at all (P2-F2), so they never render as
   "(dream hypothesis)". Once F2 is fixed the marker _would_ be misleading;
   recommended fix is a distinct `origin='distilled'`, but every `origin='dream'`
   consumer must be reviewed first — notably `findMatchingSkill`'s `!= 'dream'`
   fence, which would stop excluding it.

### Lane 3 / anticipation (Phase 3)

1. **P3-F3 (HIGH) — a surfaced brief re-enters `chunks` through the transcript.**
   The row is never a chunk, but the agent voices it, the reply lands in the
   session file, and session extraction crystallizes it. Live: 2 retrieval-eligible
   `episode` chunks carry brief content. §2.7 holds for storage and is defeated
   one turn later.
2. **P3-F4 (HIGH) — drain is per-_attempt_, not per-turn.** `runEmbeddedAttempt`
   is called inside a retry loop (context overflow, compaction, tool-result
   truncation, provider failover); each re-entry drains another brief and 3 more
   findings, stamping all of them `surfaced` while the user sees at most the
   last. This also inflates the only KPI the plan has.
3. **P3-F5 (HIGH) — D3 is unfalsifiable.** Nothing writes `'referenced'`
   (`dream_briefs.referenced_at` is written nowhere), and `markDreamConsumption`
   is set-once on `first_consumed_at`, which the `surfaced` stamp already
   consumed — so a future echo detector would be a no-op on exactly the briefs
   eligible to be referenced. The rating "proxy" writes a different column. The
   literal kill criterion always fires. Either instrument echo detection with a
   separate column, or restate D3 as a review pilot and say so.
4. **P3-F6 (MEDIUM-HIGH) — the promised grounding legs were never wired.**
   §7 requires similarity floors, source counts and a verifier; `anticipation.ts:116-127`
   checks only that the model cited >=2 integers inside the offered range. There
   is no similarity floor and no verifier call. This is the mechanism by which
   the fabricated "1,000 paying customers" brief cleared the gate. **That
   pollution is still live and still growing: 30 chunks, including a canonical
   fact created _after_ the amplification.** The lane can regenerate it.
5. **P3-F7 (MEDIUM) — the lane feeds on its own output.** Its input query treats
   `session_trust IS NULL` as first-party, which admits agent-authored handovers
   and the transcript echoes of P3-F3.
6. **P3-F8 (MEDIUM)** — brief text is served by a READ-scope RPC to the `/dreams`
   page, which still embeds the admin token for unauthenticated loopback callers
   (known deviation #1). Phase 3 widened that hole's blast radius from insight
   text to cross-session synthesis.
7. **P3-F10** — the amplified pitch-deck brief was deleted with no tombstone, so
   a brief that should never have existed is invisible to audit and the funnel
   under-reports what was produced.

## Recommendations

1. **Do not score D1 or D2 on this build**, and restate D3 before scoring it.
2. **Decide on Lane 2.** As built it degrades the index (double-indexed clusters,
   one orphaned pointer, resurrected members). Either fix P1-F1/F2/F3/F4 before
   the next cycle or disable the merge (1b) and keep 1a, which is correctness
   rather than a bet. This is a product call, not a code call, so it is left to
   Victor.
3. **Purge the "1,000 paying customers" residue again (30 chunks)** and treat
   P3-F6 as the root cause, not the individual chunks.
4. **Lane 1 needs P2-F1 before anything else** — everything downstream of the
   recorder is untested in production because nothing has ever reached it.
5. The health sweep landed today has no bell: new findings only log at `warn`,
   and nothing reads `health_sweeps` (no doctor section, no RPC, no digest
   inclusion). The premise of the feature was that nobody reads the thing that
   already logs correctly. Give it a surface.

---

## Follow-up: what was fixed (2026-08-12)

Acted on the backlog above. Committed in `7ae5db7`, deployed and live-verified.

### Two findings the pass itself did not have

**The self-healing FTS backfill was resurrecting every demoted member.**
`ensureMemoryIndexSchema` re-inserted an FTS row for any chunk missing one, with
no lifecycle filter. Deleting a member's FTS row IS the merge, so the next
`ensureSchema` — boot, sync, or db swap — put it straight back. This is the real
reason all 18 demoted members were sitting in `chunks_fts`, and it means the
merge could never have worked on any node, ever. P1-F3's swallowed catches were
a second, smaller cause. Now fenced to non-demoted lifecycles.

**A full reindex destroys every chunk no file produces.** Confirmed with a
probe: insert a scratch note, run one forced sync, row count 1 → 0.
`runSafeReindex` rebuilds into a fresh database by walking memory/session/skill
files and swaps it in, so extracted fact crystals, scratch notes, handover
crystals, dream insights and merge summaries were all deleted. The triggers are
ordinary: `force`, an embedding model or provider change, a chunking-settings
change, and an **API key rotation** (`providerKey` is part of the meta
comparison) — which silently wiped the agent's crystallized memory while leaving
file-derived chunks intact, so the index still looked healthy afterwards. New
`reindex-carryover.ts` preserves anything the rebuild did not reproduce and
re-applies demotions the rebuild cleared.

This is more severe than P1-F1 and was found only because P1-F1's fix did not
take on the first try. It is worth stating plainly: three independent mechanisms
were undoing the merge, and the two biggest were outside the merge code.

### Fixed

- P1-F1 — demotion captured before the per-file delete and re-applied after; a
  restored member is not re-indexed. Genuinely changed content still indexes fresh.
- P1-F3 — index mutations inside the merge transaction now throw and roll the
  whole merge back instead of being individually swallowed; failures log at warn.
- P1-F4 — with a live vector index, a summary that cannot be embedded refuses
  the merge outright rather than deleting members' vectors for nothing.
- P1-F2 — compression no longer archives hygiene-consolidated chunks (summary or
  member), so no more `archived` rows behind a pruned `dream_insights` parent.
- **Merge gated off**: `memory.dream.hygieneMerge.enabled`, default OFF. 1a
  embedding backfill and 1c staleness questions keep running. Re-enable only
  after a clean D2 replay.
- **Health sweep given a bell and a catch-up**: new findings enqueue into the
  surfacing queue (capped at 3, errors first) instead of only logging at warn; a
  missed daily window is caught up shortly after boot; doctor reports the
  sweep's own liveness. Its first week produced zero sweeps because the machine
  was down at 08:00 — the watchdog had the bug it exists to catch.
- Lanes 1 and 3 disabled in config (`modes.distillation`, `modes.anticipation`)
  pending P2-F1 and the Lane 3 grounding legs.

### Live verification after deploy

- Merge gate holding: newest merge summary predates the restart; none since.
- `demoted_in_fts` 18 → 0, and still 0 after a re-index cycle (previously the
  drift backfill restored them within one `ensureSchema`).
- The 18 already-demoted members were de-indexed to complete merges that had
  been half-applied; their summaries remain indexed and searchable.
- Health sweep catch-up fired ~3 minutes after boot, recorded 5 findings, and
  queued 3 for surfacing.
- Residue purge: 30 chunks + 5 canonical facts + 17 workspace files + the source
  transcript. `%paying customer%` now returns 0 chunks, 0 FTS rows, 0 canonical
  facts, and stays 0 after re-indexing. The fabricated figure was redacted in
  the origin session transcript so extraction cannot re-derive it.

### Still open from the backlog

P1-F5 (hygiene funnel rows structurally unconsumable), P1-F6 (rollback script
does not exist), P1-F7 (`staleness_asked_count` never reset), P1-F8/F9/F10/F11,
all of Lane 1 (P2-F1 first), and Lane 3's P3-F3/F4/F5/F6/F7/F8.
