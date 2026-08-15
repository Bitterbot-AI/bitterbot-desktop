# Circle messaging over a per-circle gossip topic (prototype + spec)

PLAN-36 Phase 4, the cheaper path to NAT-to-NAT circle delivery. Status:
**application layer + Rust primitive + bridge + circles-service integration all
BUILT and unit-tested (degrades gracefully without the new orchestrator);
remaining: deploy the new orchestrator binary, then shared-key confidentiality.**

## Why this over a full request-response protocol

Circle messages ride HTTP A2A today, so a NAT'd node needs a public
`a2aPublicUrl` and two home nodes can't reach each other at all. But every node
already holds a live libp2p connection to its peers through the relay fleet, and
**gossipsub already traverses those relays to every subscriber**. A per-circle
topic reuses that — NAT-to-NAT delivery with far less work than building a new
libp2p request-response behaviour (which is the other option, PLAN-35 Track B).
Trade-off: gossip is broadcast-within-topic (less efficient/private than
point-to-point), so it wants a shared-key confidentiality layer (below).

## What is built (this prototype)

`src/circles/circle-topic.ts` + tests:

- `circleTopicId(circleId, keyEpoch)` → `bitterbot/circle/<sha256(id:epoch)>/v1`.
  The hash keeps the raw circle id off the wire, and tying it to `key_epoch`
  means a removed member's subscription lands on a stale topic once the epoch
  bumps — **the first real consumer of the otherwise wired-but-dead
  `key_epoch`**.
- `publishCircleFrame(...)` / `receiveCircleFrame(...)` move a signed circle verb
  onto/off the topic, dispatched through the **same `handleCircleMethod`** path
  as a direct dial or mailbox drain — so membership, scope, injection scan, and
  envelope dedupe apply identically. A non-member's frame is refused; the
  self-published copy is deduped.
- Test proves: a signed message reaches a member with **no `a2a_url`**, over an
  in-process bus only, nothing dialed.

## What is still needed

### 1. The Rust dynamic pub/sub primitive (BUILT — compiles)

Gossipsub topics were compile-time constants; this adds a runtime primitive,
scoped to `bitterbot/circle/*/v1` only (guarded by `is_circle_topic`):

- `IpcCommand::{Subscribe,Unsubscribe}Topic { topic }` →
  `gossipsub.subscribe/unsubscribe` (`orchestrator/src/swarm/mod.rs`)
- `IpcCommand::PublishTopic { topic, data_b64 }` → `gossipsub.publish`
- inbound message on a subscribed `bitterbot/circle/*` topic → emit a
  `topic_message` IPC event `{ topic, from_peer_id, data_b64 }`

Bridge methods (`OrchestratorBridge`): `subscribeCircleTopic`,
`unsubscribeCircleTopic`, `publishCircleTopic`, `onCircleTopicMessage` — plus
`bridgeCircleTopicBus()` / `onBridgeCircleFrame()` in `circle-topic.ts` adapting
them to the `CircleTopicBus` the app layer codes against (base64 on the wire).
`cargo build` is green; a mock-bridge round-trip test covers the base64 path.

**Circles-service integration (BUILT):** `circle-topic-transport.ts` holds the
bus as a process singleton (so any per-call `CirclesService` can publish without
threading the bridge) and wires inbound `topic_message` → `receiveCircleFrame`
against the circles DB; `startCircleTopicTransport` is called at gateway startup
when the orchestrator bridge is present (guarded on `circles.enabled`).
`CirclesService.fanOut` publishes each send to the circle topic (additive to
direct/mailbox; receiver dedupe collapses overlap), and
`ensureCircleSubscriptions()` — called by the fast scheduler each cycle —
subscribes every active non-practice circle so new circles + epoch bumps stay
current. All optional: with no bus (until the new orchestrator runs) it is a
clean no-op falling back to direct-dial + mailbox.

**Still to deploy/build:** the new orchestrator binary must actually run on a
node for the primitive to exist (like the mailbox host, an infra step); then
shared-key confidentiality (§2).

**Version-skew hardening (2026-08-14, Stage 1 of the transport plan):**
pre-0.2.0 daemons dropped unknown IPC verbs _without a response_, so a
gateway with `circles.meshTopic.enabled` pointed at an old daemon stalled the
full 10s IPC timeout on every publish and on every circle's subscribe each
scheduler cycle. Three fixes, all shipped together: (1) the daemon now
answers every request that carries an id — unknown verbs and malformed
payloads get an `{ ok: false, error }` response (`orchestrator/src/ipc.rs`,
`write_ipc_error`); (2) the bridge gives topic verbs a short 2s timeout
(`TOPIC_VERB_TIMEOUT_MS`, `src/infra/orchestrator-bridge.ts`); (3) the
transport glue latches the mesh bus OFF for the process on the first
capability failure (timeout or explicit unknown-verb answer), so version
skew costs ~2s once, never per-send
(`src/circles/circle-topic-transport.ts`). Delivery is unaffected either
way — the mesh is additive; HTTP dial + mailbox carry the report.
Orchestrator version bumped to **0.2.0**; the `orchestrator-v0.2.0` release
tag is what makes `scripts/fetch-orchestrator.mjs` serve a topic-capable
prebuilt to every node.

**Hardening from the Stage 2-4 security pass (2026-08-15, orchestrator 0.2.3):**

- **Per-peer rate limit** on both mesh ingress paths BEFORE any gateway work —
  the topic-message arm and the circle-RPC request arm both go through
  `SecurityValidator::check_circle_rate` keyed on the connection peer, so an
  unauthenticated flooder is bounded before the gateway decodes a frame or
  runs a handler (the TS `rateLimited` sits behind the membership check and
  therefore never fires for a non-member — CRIT-2 / H1).
- **Verb allowlist on the topic path**: `receiveCircleFrame` dispatches only
  fire-and-forget verbs (message/ask/answer/event/presence/sender_key).
  Request/response verbs (join, roster, events.since) are refused on the
  broadcast topic — they ride the P2P/HTTP legs (H2).
- **`circle/join` checks circle existence BEFORE the rate-limit write**, so a
  bogus circle_id can't amplify into DB writes on an attacker-chosen bucket.
- **Relay carriage** is per-peer quota'd (16 topics/peer) with eviction that
  protects topics that have carried real traffic, so a junk-subscription flood
  can't evict live circles (C3); `is_circle_topic` requires the exact
  `bitterbot/circle/<64-hex>/v1` shape, killing the unbounded-topic relay OOM
  (C4/C5); `unsubscribe_topic` is gated like subscribe/publish (C7); the IPC
  socket is chmod 0600 (C7).
- **Circle-RPC held channels** are capped (256) and swept every 5s against the
  30s TTL (HIGH-4).

### 2. Confidentiality — SENDER KEYS (BUILT 2026-08-14, Stage 2)

A gossip topic is readable by anyone who subscribes, and the blinded name only
_hides_ the id (anyone who learns `circleId+keyEpoch` can recompute it).
Frames used to be signed-but-plaintext; they are now **encrypted with
per-member sender keys** (`src/circles/sender-keys.ts`, migration v61):

- **Sender keys, not one group key.** A circle has no authority — rosters are
  node-local, any member mints invites, removal is per-node consent — so a
  single group key would need a key agreement no one can run. Instead each
  member encrypts mesh frames with their OWN AES-256-GCM key and distributes
  it sealed to every member's X25519 box key over the reliable dial/mailbox
  legs (`circle/sender_key` envelopes, scope `message.send`; never over the
  topic itself). The scheduler's `ensureSenderKeyDistribution` sweep retries
  until every boxed member holds the current key, and hands new members every
  sender's key the same way.
- **Rotation on removal**: a node that removes a member rotates its sending
  key (`rotateOwnSenderKey`) — the evictee cannot read that node's future
  frames. Other members rotate when they process the removal on their own
  roster (informed consent, same as removal itself). Old keys are retired,
  not deleted, so in-flight frames still decrypt.
- **Frame binding**: the blinded topic id is the GCM AAD, so a frame lifted
  from one topic cannot be replayed onto another. Wrapper carries only
  `{enc, sender, keyId, iv, ct, tag}` — key lookup metadata, no content.
- **Transition**: receivers accept legacy plaintext frames from pre-Stage-2
  senders (that is the status quo, not a regression — the flag is off
  fleet-wide); an undecryptable frame is dropped at debug and the HTTP copy
  of the same envelope delivers. The gossip TOPIC name stays keyed by
  `key_epoch` exactly as before — naming and encryption are deliberately
  orthogonal, so no topic-desync risk is introduced (§5.5 F2/F3 stands).

What `key_epoch` still does NOT give you: topic-name rotation on removal
(unchanged, §5.5). The read-exclusion guarantee now comes from the sender-key
rotation above, not from the topic name.

## Where it fits

- **Direct HTTP dial** — fastest when a peer has a public `a2aUrl`. Keep as the
  primary for reachable peers.
- **Mailbox** (shipped, PLAN-36 Phase 1) — offline / asymmetric backstop.
- **Gossip topic** (this) — NAT-to-NAT live delivery without a public URL, once
  the Rust slice + shared key land. Supersedes the interim broker for messages.
- **libp2p request-response** (PLAN-35 Track B — BUILT 2026-08-14, Stage 4):
  `/bitterbot/circle-rpc/1` + `circle-p2p-transport.ts`. Point-to-point,
  noise-encrypted, carries request/response verbs (join, events.since,
  receipted deliveries) the broadcast topic cannot. Delivery order is now
  P2P dial → HTTP dial → mailbox; the topic remains the additive broadcast
  side-channel.

## Two-node verification (to run once the Rust slice lands)

Two NAT'd nodes (both no public `a2aUrl`), connect them, disable the HTTP path,
send both directions, confirm delivery within a gossip round-trip and that a
third node subscribed to a _guessed_ topic sees only ciphertext (after §2).
