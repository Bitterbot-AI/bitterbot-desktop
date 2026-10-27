# Local two-node mesh test

Two throwaway Bitterbot nodes on one machine, connected only to each other
over loopback, so the skill propagation path can be exercised end to end
without an LLM and without touching the public mesh:

evolved skill on A → housekeeping (evidence record, applicability profile,
signed provenance trailer) → orchestrator `publish_skill` → Gossipsub →
B's orchestrator → `skill_received` → ingest (signature, hash, binding,
applicability fit) → quarantine → operator accept → staging → evolution
status, and a signed retraction back the other way.

Each node is a real gateway with its own state dir, keys, ports and
orchestrator. Dreams, consolidation, curiosity and memory search are off in
the generated config so a test node makes no model or embedding calls. The
orchestrator runs through `orchestrator-isolated.sh`, which drops every
non-loopback bootstrap the gateway merges in from the defaults and DNS and
forces relay mode off. A test node therefore never reaches the relay fleet.

Budget: each fresh gateway settles around 700 MB RSS. On a small box stop
them as soon as the run is done.

## Run

Build first (`pnpm build`) so `dist/entry.js` is current. All paths below
are relative to the repository root. Replace `$A`/`$B` with the state dirs.

```bash
A=~/bitterbot-sim/a; B=~/bitterbot-sim/b
export A_IPC=/tmp/bitterbot-orchestrator-sim-a.sock B_IPC=/tmp/bitterbot-orchestrator-sim-b.sock

# 1. Fresh identities. A node whose key dir is empty would otherwise inherit a
#    legacy key from <repo>/keys or ~/keys and share the live node's peer id.
mkdir -p $A/keys $B/keys
for n in a b; do
  timeout 4 orchestrator/target/release/bitterbot-orchestrator \
    --ipc-path /tmp/keygen-$n.sock --key-dir ~/bitterbot-sim/$n/keys \
    --listen-addr /ip4/127.0.0.1/tcp/9299 --relay-mode off >/dev/null 2>&1 || true
  rm -f /tmp/keygen-$n.sock
done

# 2. Node A (publisher): weaker primary model so its "poor" skill reads as such on B.
node scripts/sim-mesh/write-config.mjs a 19101 9201 9857 anthropic/claude-haiku-4-5
BITTERBOT_STATE_DIR=$A BITTERBOT_ORCHESTRATOR_IPC_PATH=$A_IPC \
  setsid nohup node dist/entry.js gateway > $A/gateway.log 2>&1 < /dev/null &
until curl -sf http://127.0.0.1:9857/api/peers >/dev/null; do sleep 2; done
A_PEER=$(curl -s http://127.0.0.1:9857/api/peers | sed 's/.*"peer_id":"\([^"]*\)".*/\1/')

# 3. Node B (receiver) dials A over loopback.
node scripts/sim-mesh/write-config.mjs b 19102 9202 9858 anthropic/claude-opus-4-8 \
  /ip4/127.0.0.1/tcp/9201/p2p/$A_PEER
BITTERBOT_STATE_DIR=$B BITTERBOT_ORCHESTRATOR_IPC_PATH=$B_IPC \
  setsid nohup node dist/entry.js gateway > $B/gateway.log 2>&1 < /dev/null &
until curl -s http://127.0.0.1:9857/api/peers | grep -q '"connected_peers":1'; do sleep 2; done

# 4. Publish from A through its real housekeeping pass and orchestrator.
BITTERBOT_STATE_DIR=$A BITTERBOT_ORCHESTRATOR_IPC_PATH=$A_IPC \
  node --import tsx scripts/sim-mesh/publish-sim.mts run1

# 5. Read the result on B: review list, fit, then accept one into staging.
BITTERBOT_STATE_DIR=$B node dist/entry.js skills incoming list --json
cat $B/skills-incoming/sim-mesh-good-run1/.envelope.json | grep -A4 applicability_fit
BITTERBOT_STATE_DIR=$B node dist/entry.js skills incoming accept sim-mesh-good-run1
cat $B/skills-staging/sim-mesh-good-run1/.evolution-meta.json | grep -A4 applicabilityFit

# 6. Retract the other one from A; B drops its quarantined copy within a second.
BITTERBOT_STATE_DIR=$A BITTERBOT_ORCHESTRATOR_IPC_PATH=$A_IPC \
  node --import tsx scripts/sim-mesh/retract-sim.mts sim-mesh-poor-run1
grep -i retraction $B/gateway.log

# 7. Stop both gateways (their orchestrators exit with them) and keep or delete the dirs.
pkill -f "bitterbot-orchestrator-sim-[ab].sock"
```

Expected on B with the defaults above: `sim-mesh-good-run1` fit `good`,
score 1.0, no mismatches; `sim-mesh-poor-run1` fit `poor`, score 0.25, with
the weaker model, the declared OS, the missing binary and the thin evidence
named. The fit orders evaluation and tightens the canary; it never admits or
rejects a skill (see `docs/memory/skills-pipeline.md`).

Scripts here import from `src/` and run under `node --import tsx`; they are
not part of the build.
