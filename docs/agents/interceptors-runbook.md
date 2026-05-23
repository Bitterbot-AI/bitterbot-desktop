---
summary: "Operator runbook for pre-action interceptors (PLAN-20)"
read_when:
  - Diagnosing interceptor issues
  - Disabling or re-enabling an interceptor
  - Promoting a harvested candidate
title: "Operator Runbook — Pre-Action Interceptors"
---

# Operator Runbook

How to run, observe, and tune the pre-action interceptor layer on a live Bitterbot node.

## See what's active

**UI:** sidebar → **Active Guards**. The tab shows:

- **Registered Interceptors** — every interceptor the gateway loaded, grouped by skill, with success/failure counts and a per-skill value score.
- **Live Feed** — real-time `intervention.fired` events for the current session.
- **Auto-Disable Strikes** — interceptors that have thrown during evaluation (3 strikes → auto-disabled across restarts).
- **Dream-Harvested Candidates** — skill proposals the dream cycle drafted but hasn't promoted yet.
- **Recent Persisted Records** — last 25 signed `intervention_records` rows.

**RPC:** `guards.status` (read-only, `operator.read` scope) returns the same data over the gateway WebSocket.

```ts
await request("guards.status", {});
// → { registered, stats, recent, strikes, candidates }
```

## Disable an interceptor

Three ways, in order of strength:

1. **Persistent operator disable** — edit `~/.bitterbot/bitterbot.json`:

   ```json
   { "interceptors": { "disabled": ["calibrate-claim-confidence", "recall-before-claim:default"] } }
   ```

   Accepts either a skill name (disables all of its interceptors) or a specific interceptor id. Applied at gateway startup.

2. **Strike-driven auto-disable** — if an interceptor throws 3 times in a session, it's automatically disabled and the disable persists across gateway restarts via the `interceptor_strikes` table.

3. **One-shot UI clear** — Active Guards → click "Clear strikes & re-enable" next to an auto-disabled entry. Resets the persistent strike counter and re-enables the interceptor.

## Promote a dream-harvested candidate

The dream engine's `interceptor_harvest` mode runs once per ~2-hour deep cycle. When it finds a recurring competence gap, it stages a candidate `SKILL.md` under `~/.bitterbot/skills-staging/<name>/`.

**To promote:**

1. Open Active Guards → **Dream-Harvested Candidates** section.
2. Click "Show full SKILL.md" to review the proposal.
3. Click "Promote to skills/" — copies the file to `~/.bitterbot/skills/<name>/SKILL.md`.
4. **Important:** the staged candidate is documentation. A TypeScript implementation must be added under `src/agents/skills/builtin-interceptors/` before the skill becomes runnable. See [interceptors-author-guide.md](interceptors-author-guide.md).

Until the implementation lands, the SKILL.md sits in `skills/` advertising the proposed behavior. Mesh-acquired user-authored implementations remain gated on issue #21 (capability sandbox).

**RPC equivalent:**

```ts
await request("guards.promote_candidate", { skill: "my-auto-skill" });
// → { ok, promotedSkill, livePath }
```

## "My interceptor isn't firing" troubleshooting

Run through these in order. Each rules out a class of bugs.

### 1. Is the interceptor registered?

Open Active Guards. If your interceptor isn't in the **Registered Interceptors** list, the registration didn't run. Check:

- `src/agents/skills/builtin-interceptors/index.ts` has the `registry.register(myGuard, "builtin")` call
- The gateway bundle is current: `node scripts/build-gateway-entry.mjs` + restart
- Your skill name isn't in `interceptors.disabled` in `bitterbot.json`
- The interceptor hasn't been auto-disabled (check the Auto-Disable Strikes panel)

### 2. Is the tool pre-filter blocking it?

If `tools: ["send_message"]` but the actual tool name in your session is `discord_send`, the pre-filter skips evaluation entirely. Either:

- Add the actual tool name to the `tools` array
- Remove `tools` entirely (interceptor evaluates on every tool call — costs more)

### 3. Is the StepContext populated?

The session-context tracker fills in turns/tools/channel from `server-chat.ts` and `server-methods/chat.ts`. If the interceptor checks `ctx.recentTurns` or `ctx.toolHistory` and finds them empty, the user just hasn't had enough turns yet in this session — the ring buffer is per-session and starts empty.

The hormonal/GCCRF snapshots come from `MemoryIndexManager.get()` lazily. On a fresh gateway boot the first ~100ms of agent activity may see neutral defaults instead of live values. This is intentional (fail-safe degradation).

### 4. Is `maxFiresPerEpisode` exhausted?

The runner enforces a per-session fire cap. Check the fire count in Active Guards. If it equals `maxFiresPerEpisode`, the interceptor is silently skipped for the rest of the session. Either raise the cap or wait for a new session.

### 5. Is something throwing?

Check Active Guards → **Auto-Disable Strikes**. If your interceptor is listed there, it threw during `shouldActivate` or `intervene`. The "Last failure reason" field shows the exception. Fix the code, clear the strikes, restart.

### 6. Is the latency budget being exceeded?

If the total time across all interceptors exceeds 50ms cumulative, the runner short-circuits and skips the remainder. Check gateway logs for `interceptor budget exceeded`. Profile slow interceptors with `console.time` and tighten them.

## Interpreting outcome tags

The outcome backfill module patches a tag onto every persisted record 1–3 turns after firing, based on the user's reply:

| User reaction                                       | Tag                    | Meaning                               |
| --------------------------------------------------- | ---------------------- | ------------------------------------- |
| "thanks", "perfect", "exactly", "yes"               | `downstream-success`   | The intervention helped.              |
| "wrong", "no", "try again", "huh"                   | `downstream-failure`   | The intervention was wrong / harmful. |
| "yes do it", "confirm", "proceed" (after a `block`) | `user-overrode-block`  | The user disagreed with the block.    |
| "cancel", "don't", "stop" (after a `block`)         | `user-confirmed-block` | The user agreed with the block.       |
| (no distinct reaction)                              | `no-signal` / NULL     | Inconclusive.                         |

A high `downstream-failure` rate on an interceptor is a strong signal to tighten its `shouldActivate` predicate. A high `user-overrode-block` rate means the block is firing too often relative to what the user actually considers risky.

## Manually triggering the harvest

`interceptor_harvest` runs as part of the regular 2-hour deep dream cycle. To force a cycle, use:

```ts
await request("dream.trigger", { mode: "interceptor_harvest" });
```

(Requires `operator.write`. The dream engine accepts the mode hint and includes it in the cycle's mode rotation.)

Without a configured LLM provider, harvest produces heuristic-only proposals — no SKILL.md is staged. Wire an LLM via `dream.llmCall` config to get typed candidates.

## Direct database inspection

For deep troubleshooting:

```bash
sqlite3 ~/.bitterbot/<agent>.sqlite
.schema intervention_records
.schema interceptor_strikes

SELECT skill, COUNT(*) FROM intervention_records GROUP BY skill;
SELECT * FROM skill_interceptor_stats WHERE failure_count > 0;
SELECT * FROM interceptor_strikes;
```

## Related

- [interceptors.md](interceptors.md) — architecture overview
- [interceptors-author-guide.md](interceptors-author-guide.md) — how to write a new interceptor
- [interceptors-troubleshooting.md](interceptors-troubleshooting.md) — quick FAQ
