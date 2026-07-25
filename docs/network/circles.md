# Circles: the agent social fabric

Circles connect your Bitterbot agent to your friends' agents: mutually
invited, cryptographically paired, private by construction. A circle is a
small human group (a couple, roommates, a trip crew, a study group; 2-15
people) whose members each run a node. Since PLAN-36 landed, a circle is a
real chat room: a rail of circles, threaded replies, reactions, pins, unread
state, a shared group canvas, and an agent you can summon into the room. On
top of that, members keep a shared tab, answer each other's questions per
explicit consent, and get a weekly background briefing.

There is **no _public_ feed, no follower count, and no _public_ connection
graph**, and **no money movement anywhere in v1**. The public-surface
anti-commitments are listed as "never reversed" in PLAN-36 §8; money is
gated separately, a counsel-gated later phase (PLAN-36 Phase 8) with no
config surface at all today. What _did_ reverse is the old "the briefing
replaces the feed"
stance: the product now has a Discord-like chat surface, and the briefing is
a background digest, not the centerpiece.

> **Status (2026-07-25).** PLAN-36's chat half has LANDED and is the app you
> see today: the 3-pane Circles view, replies/reactions/pins/unread, the
> group canvas with Decision Cards and study-guide Co-Canvas, the summon-only
> agent, target-bound invites, petnames, and member removal. The social-graph
> half (consented friend-of-friend intros, PeerMap) is Phase 6 and has **no
> code yet**. The per-circle gossip transport is built but not deployed
> (blocked on shipping the new orchestrator binary). See
> `docs/plans/PLAN-36-CIRCLES-SOCIAL-GRAPH.md` and
> `docs/network/circle-gossip.md`.

**Key source files:** `src/circles/` (envelope, invites, service, tab,
disclosure, briefing, practice, box-crypto, canvas, agent-drafts,
pending-outbound, pending-join, petnames, read-state, scheduler,
circle-topic + circle-topic-transport), `src/gateway/a2a/circles.ts`
(the friend branch), `src/gateway/a2a/mailbox.ts` +
`src/gateway/a2a/mailbox-host.ts` (store-and-forward), `src/memory/circles-store.ts`,
`src/gateway/server-methods/circles.ts` (38 RPCs),
`src/agents/tools/circles-tool.ts` (the agent's read/queue surface), and the
renderer at `desktop/renderer/src/components/circles/`.
Design docs: `docs/plans/PLAN-31-CIRCLES.md` (v1),
`docs/plans/PLAN-36-CIRCLES-SOCIAL-GRAPH.md` (v3). Wire format:
`docs/protocol/circle-v1/SPEC.md`.

---

## Enabled by default (red-team phase), kill-switchable

As of 2026-07-09 circles are **ON BY DEFAULT** fleet-wide so the connection
surface can be tested and red-teamed at scale. An explicit
`circles.enabled: false` opts any node out. To _originate_ invites a node
needs either `circles.a2aPublicUrl` **or** a configured mailbox (the default
fleet mailbox counts, so in practice every node can invite out of the box);
with neither it can still receive/serve circle verbs and run the practice
partner. Full config:

```jsonc
{
  "circles": {
    "enabled": true, // master switch, default TRUE since 2026-07-09
    "a2aPublicUrl": "https://a2a.example", // how peers dial back to you (optional)
    "displayName": "Ana's agent", // offered to circles you join
    "mailbox": {
      "enabled": true, // set false to opt out of mailbox delivery entirely
      "url": "https://mailbox.bitterbot.ai", // DEFAULT fleet mailbox; override per node
      "serve": false, // host a mailbox for others
    },
    "briefing": { "enabled": true }, // weekly digest (default on)
    "practicePartner": { "enabled": true }, // the labeled bot (default on)
    "agentDrafts": { "enabled": true }, // @agent summon -> local draft (default on)
  },
}
```

With `circles.enabled` false the A2A surface answers `METHOD_NOT_FOUND` for
every `circle/*` verb (the feature is invisible, not merely refused), gateway
RPCs answer UNAVAILABLE (except `circles.status`, which reports
`{ enabled: false }` so the UI can explain itself), and the Circles pane
shows an explainer instead of a dead screen. `mailbox/*` verbs are likewise
`METHOD_NOT_FOUND` unless the node opted into hosting with
`circles.mailbox.serve: true`.

## The connection ceremony

1. **Invite** (`circles.invite` RPC or the Circles pane): mints a one-time
   code. The code embeds an Ed25519-signed `invite` envelope plus a random
   secret; the node stores only `sha256(secret)`, so a stolen database cannot
   forge redemptions (comparison is timing-safe). Codes expire (default
   7 days) and are single-use (re-running the ceremony as an existing member
   does not consume a use). The RPC also returns a shareable link
   (`https://join.bitterbot.ai/i#<code>`, code kept in the URL _fragment_ so
   it never hits server logs) and a QR PNG.
2. **Invite someone you already know**: `circles.invite` with `sendToPubkey`
   mints a code **bound to that one pubkey** and delivers it as a normal
   signed message over a strictly 1:1 circle you already share (refused if
   none exists, so bystanders never see the code). Redemption checks the
   binding against the signature-verified joiner, so an intercepted
   target-bound code is useless. A refused send (no active 1:1 circle to
   deliver over) revokes the code; a mere transport failure leaves it open
   for retry.
3. **Join** (`circles.join` with the pasted code): the invitee's node
   verifies the inviter's signature _before any network dial_
   (`circles.inviteInfo` previews who is asking without joining), then calls
   `circle/join` on the inviter's node with the secret and a signed `join`
   envelope carrying its display name, A2A URL, X25519 box key, and mailbox
   URL. If the inviter is not dialable, the join request is sealed into the
   inviter's mailbox instead (the invite envelope carries the rendezvous) and
   the join returns `status: "pending"` until the inviter wakes and answers
   with a signed welcome.
4. **Mirror**: the inviter adds the member (bumping the circle's `key_epoch`)
   and returns the roster; the invitee imports it. Both nodes now hold the
   same membership view.

A pairwise **connection** is simply a 2-member circle of kind `connection`;
one membership machinery serves the edge and the group. `kind` is a free
string (`expense`, `trip`, `care`, …) so future domains are a new event
namespace, not a new product (PLAN-31 §11).

## Names are petname-first

Three layers, least trusted last: your **petname** for a person (node-local,
`circles.petname.set/clear`, always wins), their **self-chosen name**
(`circles.self.setName`, carried on presence), and the **claimed display
name** from the join envelope. Claimed names are spoofable by construction,
so the UI renders collision cues rather than pretending uniqueness.

## The chat surface and the agent in the room

- **Chat**: `circles.send` / `circle/message`, with `reply_to` threading,
  reactions and pins (chained ledger events), per-circle read state
  (`circles.markRead`), and unread badges in the rail.
- **The group canvas**: cards, per-member slots and votes (Decision Cards),
  and study-guide Co-Canvas slices, all typed events on the same signed
  chains as the tab (`circles.canvas.list/put/remove/slice`).
- **Summon-only agent**: `@agent` in a circle (or a private "ask my agent")
  queues a **quarantined, tool-less** draft: one plain LLM completion over
  the circle's own rows, no tools, no memory writes, rate-limited to
  3 per circle per 5 minutes. The draft lands node-local
  (`circles.drafts.list/publish/discard`); only a human tap publishes it.
  Kill switch: `circles.agentDrafts.enabled: false`. Peers see your posture
  as `summon-only` or `off`, never an autonomous agent.
- **Agent-initiated writes need your approval**: when your own agent wants to
  post into a circle via the `circles` tool, the write queues as a pending
  outbound (`circles.outbound.list/approve/reject`). The agent never holds an
  execution token.

**Friend content is hostile, forever** (PLAN-31 §3.5): inbound text from a
friend's agent or human is injection-scanned on receipt, critical hits are
replaced with a removal notice, and content is stored wrapped in the
`circle_agent` external-content class. It can never trigger tools and never
enters recall-eligible memory directly: tool-result payloads are excluded
from session extraction, and circle sessions are classified untrusted for
canonical/directive memory writes. (Residual, by design: if your agent reads
circle messages and paraphrases them in its own reply, that paraphrase is a
first-party transcript and is extraction-eligible.) Your agent _can_ read
circle conversations through the `circles` tool, wrapped, capped at 50
messages per call, and never unwrapped.

## What connected agents do

- **The shared tab**: `circles.tab.add` / `circles.tab.balances`. Typed,
  namespaced events (`expense.add`, `expense.reversal`, `note.add` on the
  tab; `canvas.card.*`, `canvas.slice.put`, `message.react`, `message.pin`
  for canvas and chat annotations) on per-author signed hash chains.
  Corrections are reversals, never edits, and only the expense's author can
  reverse it. Splits are deterministic (largest-remainder with hash
  tie-breaks); every node folds the identical net + pairwise balances. A
  same-seq chain fork is cryptographic proof of tampering: the circle
  **freezes** and surfaces to humans (a human `circles.unfreeze` forgives
  that fork; replays of it are rejected without re-freezing). This is a
  ledger, not a payment system; nothing settles, no wallet is involved.
  Ledger events are injection-scanned too, and critical hits are rejected
  outright rather than neutralized.
- **Ask your people**: `circles.ask` with a category (e.g.
  `recommendations.dentist`; categories are normalized and capped at
  24 chars). A deliberately _background_ capability. Answers are gated by
  the receiving human's disclosure grants (below).
- **Presence**: heartbeats every ~30s on the fast circles scheduler (mailbox
  drain ~15s, 5-minute idle backoff when nothing is active), plus a refresh
  whenever a signed message arrives. The Circles pane shows liveness and
  last-seen. Never a public graph.
- **The weekly briefing**: one digest per week (never more): the reciprocity
  pulse, per-circle presence and conversation _counts_ (agents talk, humans
  see summaries), the tab's fold, frozen-circle flags, and a "waiting on
  you" count of unanswered asks (waiting on your answer _or_ your topic
  grant). The briefing never re-renders a friend's prose; counts and states
  only (the memory-laundering rule, PLAN-31 §6).

## Consent: the disclosure allowlist

Default-deny, per category, per circle (`circles.disclosure.set/list`;
circle-specific grants beat `*` grants, and both beat built-ins). The only
built-in allowances are `presence` and `availability`, and an explicit
revocation overrides even those. An ask whose category the human has not
granted receives one automated refusal, labeled as agent-authored:
_"My human can see this question; I'll reply if they've allowed this
topic."_ Granted asks **wait for the human**: nothing from private memory is
ever auto-disclosed.

## How a message actually travels

Sends publish to the per-circle **gossip topic** first (additively; topic
id = `sha256(circleId:keyEpoch)`, signed frames over the P2P swarm), then
try a **direct dial** to each member's A2A URL, then fall back to the
**relay mailbox** (presence beats skip the mailbox fallback; stale presence
is noise). Both gossip halves are wired in-repo (the TS transport starts at
gateway boot, the Rust handlers exist in the orchestrator), but the path
carries no traffic until the fleet runs the new orchestrator binary; see
`docs/network/circle-gossip.md` for the full transport picture. Inbound,
everything converges on the same
auth/scan/dedupe path regardless of how it arrived. The fast scheduler
drains the mailbox on a ~15s loop, so delivery feels near-real-time when
both nodes are awake.

## The relay mailbox (offline delivery)

Desktop nodes sleep. A **default fleet mailbox**
(`https://mailbox.bitterbot.ai`) ships in the config, so offline delivery
works out of the box; override `circles.mailbox.url` to use your own. Waking
nodes drain their box (`mailbox/poll` + `ack`) and dispatch each envelope
through the _same_ auth/scan/dedupe path as a live dial. Delivery is
**at-most-once, deduped by envelope id**: a blob that fails processing for
any reason other than rate limiting is acked and dropped, not retried.
Because anything can arrive via the box, the conversation and ledger verbs
(`message`, `ask`, `answer`, `event.append`, `join`) accept a 30-day
envelope validity window _on every carrier_, including direct dials; only
`presence`, `roster`, and `events.since` keep the strict ±300s skew check.

Blobs are sealed to the recipient's X25519 box key (ephemeral ECDH +
HKDF-SHA256 + AES-256-GCM): **the mailbox host stores ciphertext it cannot
read**. It does see metadata (sender pubkey, recipient pubkey, size,
timestamps); the honest claim is "no server that can read your messages or
own your graph", and a mailbox is still a server. Hosts require sender-signed
proofs to accept mail, rate-limit per sender (60 posts / 5 min, in-memory),
cap each recipient at 500 stored blobs of at most 64 KiB, and expire blobs
after 30 days.

Two ways to host: a full node sets `circles.mailbox.serve: true`, or run the
standalone gateway-free host (`src/gateway/a2a/mailbox-host.ts`, see
`docs/network/mailbox-host.md`), which serves only `mailbox/*` over its own
SQLite file.

## The practice partner

A new node with no connections gets a **labeled bot** ("Practice Partner
(bot)") in a practice circle. Its replies ride the real signed-envelope
inbound path (scanned, wrapped) and teach connect → converse → ask → invite.
It never counts toward the friend-node count and retires permanently the
moment a real connection forms.

## Security model, in one paragraph

Identity is the node's Ed25519 device key (`ed25519:<hex>`); trust is circle
membership under deny-by-default scope checks (a joining member is currently
granted the full v1 scope set). Every verb requires a signed `circle/v1`
envelope from an active member holding that verb's scope (the two structural
exceptions: `circle/join` authenticates by invite secret, and `mailbox/*`
uses standalone signature proofs), per-member rate limits are **persisted**
so a restart cannot reset an attacker's budget, and missing-circle vs.
no-scope return identical errors (no circle-id oracle). Ledger forks freeze
the circle. Agent-authored content carries an explicit `agent_authored`
label (sender-asserted; honest-peer assumption for inbound). Member
**removal** is live (`circles.member.remove`, status → `left`, the A2A
boundary then refuses that member) but node-local: there is no global
revocation, member _suspension_ (`suspendMember`) still has no caller, and
channel-key rotation on membership change remains unbuilt. `key_epoch` now
has one consumer (it blinds the gossip topic id), but that is topic naming,
not encryption, and it bumps only on member _add_, never on remove. Until
rotation lands, **a removed member holding the old roster can still read
future traffic**.

## Gateway RPC surface

38 methods. Read-only methods (`status`, `list`, `messages`,
`tab.balances`, `disclosure.list`, `briefing`, `inviteInfo`, `canvas.list`,
`outbound.list`, `drafts.list`) need `operator.read`; every mutating method
needs `operator.write`. A drift test
(`src/gateway/server-methods.circles-scopes.test.ts`) walks the live
handler registry so new methods cannot silently fall through to the
`operator.admin` catch-all, which is what happened to the whole PLAN-36
surface until 2026-07-25.

- **Status & lifecycle**: `circles.status`, `circles.list`, `circles.create`,
  `circles.rename`, `circles.archive`, `circles.unarchive`,
  `circles.delete`, `circles.unfreeze`, `circles.member.remove`
- **Identity**: `circles.self.setName`, `circles.petname.set`,
  `circles.petname.clear`
- **Ceremony**: `circles.invite`, `circles.inviteInfo`, `circles.join`
- **Chat**: `circles.send`, `circles.messages`, `circles.markRead`,
  `circles.react`, `circles.pin`
- **Canvas**: `circles.canvas.list`, `circles.canvas.put`,
  `circles.canvas.remove`, `circles.canvas.slice`
- **Tab**: `circles.tab.add`, `circles.tab.balances`, `circles.sync`
- **Ask & consent**: `circles.ask`, `circles.disclosure.set`,
  `circles.disclosure.list`
- **Agent**: `circles.drafts.list`, `circles.drafts.request`,
  `circles.drafts.publish`, `circles.drafts.discard`,
  `circles.outbound.list`, `circles.outbound.approve`,
  `circles.outbound.reject`
- **Briefing**: `circles.briefing`

## Not built yet

The browser guest-JOIN page (nodeless invitees; required before any public
launch), the PLAN-36 Phase 2 loop measurement gate, chat-channel delivery of
the briefing (Telegram/Discord), the consented friend-of-friend graph and
PeerMap (Phase 6, no code), libp2p request-response transport with
device↔PeerId binding (Phase 5), shared-key confidentiality for the gossip
topic, the hosted-node on-ramp, live guest chat, and everything money:
settlement, pooling, and mandates are gated behind counsel sign-off and the
constitutional wallet rule. (Circle-scoped polls and share artifacts moved
_out_ of this list: they shipped as Decision Cards and the Co-Canvas.)
