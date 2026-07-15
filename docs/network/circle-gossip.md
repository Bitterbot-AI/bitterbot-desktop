# Circle messaging over a per-circle gossip topic (prototype + spec)

PLAN-36 Phase 4, the cheaper path to NAT-to-NAT circle delivery. Status:
**application layer prototyped + tested; Rust dynamic-pubsub primitive + bridge
BUILT (compiles); circles-service integration + shared-key confidentiality still
to build.**

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

**Still to build — the circles-service integration:** (a) subscribe to each
active circle's topic on boot/join, (b) publish outbound over the topic when a
member has no reachable `a2aUrl`, (c) feed `topic_message` into
`receiveCircleFrame` with the right circle DB.

Guard rails the security review must cover: rate-limit inbound topic frames
per-peer (reuse the circle rate buckets); cap subscribed topics per node;
gossipsub already signs+scores messages, but the per-frame circle envelope auth
is what actually gates membership.

### 2. Confidentiality — the shared circle key (consume `key_epoch` for real)

A gossip topic is readable by anyone who subscribes, and the blinded name only
_hides_ the id (anyone who learns `circleId+keyEpoch` can recompute it). Frames
here are **signed and authentic but not confidential** over the shared mesh.
Real privacy needs a **per-circle shared symmetric key**:

- established at join (e.g. sender-keys / a group-key wrapped to each member's
  X25519 box key in the join/roster response),
- **rotated on every membership change**, keyed by `key_epoch` — closing the
  post-compromise gap the store docstring already promises but never delivered,
- frames encrypted with the current epoch's key before `publishCircleTopic`.

Until that lands, the topic path is fine for non-sensitive presence/typing
ephemera and for a spike, but message _bodies_ should stay on the
sealed-mailbox / direct path.

## Where it fits

- **Direct HTTP dial** — fastest when a peer has a public `a2aUrl`. Keep as the
  primary for reachable peers.
- **Mailbox** (shipped, PLAN-36 Phase 1) — offline / asymmetric backstop.
- **Gossip topic** (this) — NAT-to-NAT live delivery without a public URL, once
  the Rust slice + shared key land. Supersedes the interim broker for messages.
- **libp2p request-response** (PLAN-35 Track B) — the point-to-point alternative
  if gossip's broadcast/efficiency cost proves too high; more Rust.

## Two-node verification (to run once the Rust slice lands)

Two NAT'd nodes (both no public `a2aUrl`), connect them, disable the HTTP path,
send both directions, confirm delivery within a gossip round-trip and that a
third node subscribed to a _guessed_ topic sees only ciphertext (after §2).
