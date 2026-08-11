---
summary: "Quick FAQ for pre-action interceptor problems"
read_when:
  - An interceptor isn't behaving as expected
  - Active Guards UI shows something unexpected
title: "Troubleshooting — Pre-Action Interceptors"
---

# Troubleshooting

Quick lookups for the most common interceptor issues. See [interceptors-runbook.md](interceptors-runbook.md) for the longer-form operator guide.

## "Active Guards shows zero registered interceptors"

The gateway bundle is stale. Rebuild and restart:

```bash
node scripts/build-gateway-entry.mjs
pkill -f bitterbot-gateway
pnpm start gateway
```

If still zero after restart, check the gateway log at `/tmp/bitterbot/bitterbot-<date>.log` for `interceptor` lines. The autoboot logs `interceptors autoboot:` on its first invocation; missing log means the runner module never loaded (likely a TypeScript build issue).

## "My interceptor is registered but never fires"

Walk this list:

1. **Tool name mismatch.** The `tools: [...]` pre-filter is case-sensitive and exact-match. If your actual tool is `discord_send_message` and your filter is `send_message`, it's skipped.
2. **Predicate returns false.** Add a `console.log` in `shouldActivate` to confirm it runs. Likely the StepContext field you're reading is empty or has a different shape than expected.
3. **`maxFiresPerEpisode` exhausted.** Check the fire count in Active Guards. Reset by starting a new session.
4. **Disabled.** Check Auto-Disable Strikes and the operator disabled list in `bitterbot.json`.
5. **Higher-priority interceptor short-circuited.** A higher-priority `block` or `require_prereq` returns immediately and your interceptor never runs. Check the priority order in `candidatesFor`.

## "Interceptor fires but the params aren't being modified"

Make sure your `intervene` returns the right shape:

```ts
return {
  type: "modify",
  newParams: { ...action.params, text: rewritten }, // include all keys, not just the change
  reason: "explanation",
};
```

Common mistakes:

- Returning only the rewritten field (`{ text: rewritten }`) without spreading the original params — downstream code may expect other keys.
- Mutating `action.params` directly instead of returning a new object. `action.params` is `Readonly`.

## "The agent ignores my require_prereq directive"

The agent reads the `INTERCEPTOR:` text from the tool error and follows it most of the time. If it's regularly ignoring directives:

1. **Wording is unclear.** Look at the actual error text. It should literally name the tool and a JSON args block. If your reason is too long or buries the tool name, the model may miss it.
2. **The prereq tool doesn't exist.** The model can't call a tool that isn't registered. Confirm the tool name matches one in `src/agents/tools/`. Run `agents.list` RPC to see the loaded set.
3. **Model is in a weird mode.** Some thinking modes change instruction-following behavior. Test with the default chat surface first.

## "Block intervention shows up as a generic tool error"

PLAN-20 wraps blocks with `userVisibleMessage` into a structured `INTERCEPTOR-BLOCK:` envelope. If the user is still seeing a raw error:

1. Confirm your `intervene` sets `userVisibleMessage` (not just `reason`).
2. Restart the gateway to pick up any system-prompt changes.
3. The system prompt teaches the agent to surface block messages verbatim — if it isn't, the agent's system prompt section may have been overridden by a custom GENOME.md / MEMORY.md.

## "Latency budget warnings in the log"

Log line: `interceptor budget exceeded; skipping remaining (tool=X)`.

This means total `shouldActivate + intervene` time for ALL evaluated interceptors crossed 50ms. Lower-priority interceptors got skipped. Either:

- Profile and tighten the slow interceptor (most often: a regex compiled on every call instead of once at module top).
- Reduce the number of active interceptors.
- Add a `tools: [...]` pre-filter to skip unrelated tool calls quickly.

## "Outcome tags are always NULL"

The backfill runs from `server-methods/chat.ts` and `server-methods/agent.ts` after every user turn. If your inbound path uses neither RPC (e.g. a raw adapter calling the runner directly), backfill won't trigger. Either:

- Route inbound messages through `chat.send` / `agent`.
- Call `backfillFromUserMessage(sessionKey, text)` manually from your inbound handler.

**The session key must match on both sides.** Backfill matches pending records with
`WHERE session_key = ?`, so the key it is called with has to be the same string the
interceptor runner stamped onto the record. That is the CANONICAL key, lowercased
(`agent:<agentId>:<key>`) — not the raw key a client sent. Check with:

```sql
SELECT DISTINCT session_key FROM intervention_records;
```

If you see `__anon__`, the runner never received a session key: the tool reached
`toToolDefinitions` without the before-tool-call marker, so the adapter re-ran the hook
with no context. That marker is a non-enumerable symbol, and any wrapper rebuilding the
tool with `{ ...tool }` drops it — use `carryToolMarkers` (`pi-tools.types.ts`) in every
new tool wrapper. Records written under `__anon__` can never be backfilled and, because
`interceptor_harvest` wakes only at >=10 tagged records, the harvest mode stays asleep
forever.

## "The harvest mode never produces candidates"

Check the criteria in order:

1. **At least 3 records in the last 7 days for the same `(tool, channel, hormonal-band, param-shape)` cluster.**
2. **At least 40% of those records have `outcome_tag IN ('downstream-failure', 'user-overrode-block')`.** Without outcome backfill, all tags are NULL → 0% → no clusters survive.
3. **An LLM provider is configured.** Without one, harvest emits a heuristic insight but does not stage a SKILL.md.

Force a manual cycle: `dream.trigger { mode: "interceptor_harvest" }`.

## "How do I read a signed record offline?"

```bash
sqlite3 ~/.bitterbot/<agent>.sqlite
SELECT record_json FROM intervention_records WHERE id = '<uuid>';
```

The `record_json` column is the full canonical signed form. The signature is over the canonical JSON (id / ts / sessionKey / skill / interceptorId / stateSummary / actionOriginal / actionFinal / intervention / metadata). Verify with the node's public key from `~/.bitterbot/identity/device.json`.

## "I want to test interceptors in a fresh session"

Sessions are per-keyed by `sessionKey`. To get a clean state without restarting the gateway, just send a message to a new session key:

```ts
await request("chat.send", {
  sessionKey: "test-fresh-1",
  message: "hello",
  idempotencyKey: crypto.randomUUID(),
});
```

The per-session fire-count, turn-count, tool-history all start at zero.

## Related

- [interceptors.md](interceptors.md) — architecture overview
- [interceptors-runbook.md](interceptors-runbook.md) — full operator guide
- [interceptors-author-guide.md](interceptors-author-guide.md) — adding a new interceptor
