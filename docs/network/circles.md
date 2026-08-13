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

> **Status (2026-08-13).** PLAN-36's chat half has LANDED and is the app you
> see today: the 3-pane Circles view, replies/reactions/pins/unread, the
> group canvas with Decision Cards and study-guide Co-Canvas, the summon-only
> agent, target-bound invites, petnames, and member removal. The guest-JOIN
> page and default mailbox host are DEPLOYED and serving (see "Built and
> deployed" below). The social-graph half (consented friend-of-friend
> intros, PeerMap) is Phase 6 and has **no code yet**. The per-circle gossip
> transport is built but held dark behind `circles.meshTopic.enabled`
> (default off) until frames are encrypted. See
> `docs/plans/PLAN-36-CIRCLES-SOCIAL-GRAPH.md` and
> `docs/network/circle-gossip.md`.

**Key source files:** `src/circles/` (envelope, invites, service, tab,
disclosure, briefing, practice, box-crypto, canvas, agent-drafts,
pending-outbound, pending-join, petnames, read-state, scheduler,
circle-topic + circle-topic-transport), `src/gateway/a2a/circles.ts`
(the friend branch), `src/gateway/a2a/mailbox.ts` +
`src/gateway/a2a/mailbox-host.ts` (store-and-forward), `src/memory/circles-store.ts`,
`src/gateway/server-methods/circles.ts` (50 RPCs),
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

0. **Create** (Phase B): a circle is named _before_ it exists — the "New
   circle" modal carries the name on the first `circles.invite` (or creates
   without inviting via `circles.create`), and every further mint in that
   modal reuses the same circle, so repeated taps can never silently mint
   duplicates. Each circle renders a stable identity everywhere it appears:
   a circleId-derived gradient plus the name's leading emoji (or initials).
   Archiving actually hides the tile; a rail toggle reveals archived circles
   for restore.
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
   (`circles.inviteInfo` previews who is asking without joining). Every UI
   join path — the in-message "Join this circle" tap _and_ the paste-a-code
   box — runs the same signature-verified trust prompt (known contact vs
   stranger) before redeeming; joining then calls
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
  (`circles.markRead`), and unread badges in the rail. **The timeline reads
  like a chat app**: consecutive messages from the same author inside a
  10-minute window group under one header (a hover reveals the follow-up
  timestamps), day dividers orient history, and a "New" line — frozen at
  the read marker as it stood when the circle was opened (`lastReadAt` on
  `circles.list`) — marks what arrived since you last looked. Scroll is
  anchored: it follows the conversation only when you are already at the
  bottom; otherwise a "N new messages" pill counts what you're missing, and
  "Load earlier messages" pages history (`circles.messages` with `before` +
  `limit`). Bodies render **restricted markdown** (links, lists, code,
  quotes, tables; images never load and headings demote to bold — peer
  content stays inert) while the stored row keeps its untrusted-content
  wrap for agent consumers. **Deletion**
  (`circles.message.delete`): deleting your own message emits a
  `message.delete` event on your signed chain, so it replicates like any
  ledger write and honest peer nodes tombstone their copy too (content
  blanked, row kept so reply threads hold their anchor; only the message's
  author can tombstone it). Deleting someone else's message hides it on
  your node only. Honor-system by construction: a modified peer node can
  keep its copy, and the UI never promises otherwise.
- **The group canvas**: always visible under the member roster (never
  behind a tab). Cards, per-member slots and votes (Decision Cards),
  study-guide Co-Canvas slices, and **mermaid diagram cards** (`cardType:
"mermaid"`, rendered client-side with `securityLevel: "strict"` because
  card text is peer content), all typed events on the same signed chains as
  the tab (`circles.canvas.list/put/remove/slice`). Any chat message can be
  promoted to a note card from its hover menu — the chat scrolls away, the
  canvas is where things stop scrolling.
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
- **The study lens (Phase 4b, 2026-07-27)**: "Study with my agent" on a
  study-guide card queues a `study` draft on the same quarantined tool-less
  path — a personal quiz + gap map built from the group's shared guide,
  tuned to YOUR mastery state (a trusted-frame summary of your own past quiz
  results; the guide content rides inside the untrusted envelope). The
  result renders to you only: the server refuses to publish `study` drafts,
  so nothing on this path can reach the circle. Quiz taps
  (`circles.study.record`) feed a node-local Leitner ladder
  (`circle_study_state`, boxes 0-4 → 1d/3d/7d/14d/30d reviews); due
  sections get a "review due" badge (`circles.study.state`). Member-own
  data end to end — the shared artifact is processed, never remembered
  (§5.2), and only your own results persist.

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
  for canvas and chat annotations; `sandbox.*` for the PLAN-38 canvas
  sandbox — frame, enroll, move, close, plan, evidence — with a closed move
  grammar, one honored move per (card, author, round), and deterministic
  per-round speaker order) on per-author signed hash chains.
  Corrections are reversals, never edits, and only the expense's author can
  reverse it. Splits are deterministic (largest-remainder with hash
  tie-breaks); every node folds the identical net + pairwise balances. A
  same-seq chain fork is cryptographic proof of tampering: the circle
  **freezes** and surfaces to humans (a human `circles.unfreeze` forgives
  that fork; replays of it are rejected without re-freezing). This is a
  ledger, not a payment system; nothing settles, no wallet is involved.
  Ledger events are injection-scanned too, and critical hits are rejected
  outright rather than neutralized.
- **Living cards** (PLAN-38 P1): every card on the canvas is a workspace your
  agent and your friends' agents work alongside you. There is no session to
  open and no per-card setup — a card exists, so it can be worked. One
  standing choice per circle ("my agent works on this canvas") turns it on;
  peers see only your advertised `mode` (a signed, circle-wide
  `sandbox.enroll.put`), while budgets, guidance, and pause state live in a
  node-local table and gate all spend. Contributions are typed moves
  (constraint / option / vote / pass) folded deterministically on every node,
  at most one per member per round, with speaker order derived from the
  ledger. P1 is propose-mode only: every agent contribution is drafted on the
  quarantined tool-less path (opaque `M1..Mn` author ids in the prompt —
  display names never enter it) and posts only on its own human's tap. You can
  always contribute by hand with no agent involved. Agent generation is ON by
  default; `circles.sandbox.enabled: false` stops all agent spend on this
  node, and a circle where nobody turned participation on does no work at all.
  In a solo circle the labeled practice partner seats itself so the loop is
  exercisable with one human. Chat-side agents see the folded canvas state
  (R35 — the reverse never happens: sandbox generations never ingest chat).
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
is noise). The gossip path is behind the **`circles.meshTopic.enabled` kill
switch, default OFF since 2026-08-13**: topic frames are signed but NOT
encrypted (the blinded topic id hides only the circle id), so the mesh path
stays dark until per-circle shared-key encryption lands — delivery never
depended on it. Both gossip halves are wired in-repo (the TS transport
starts at gateway boot when the switch is on, the Rust handlers exist in
the orchestrator); see `docs/network/circle-gossip.md` for the full
transport picture. Inbound,
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
proofs to accept mail, rate-limit per sender (60 posts / 5 min, persisted in
`mailbox_post_log` so a host restart does not reset the window), cap each
sender at 50 stored blobs per recipient and each recipient at 500 stored
blobs of at most 64 KiB, and expire blobs after 30 days. At the 500-blob
ceiling the host does not refuse new mail (that would let attacker-minted
throwaway keys pre-fill a box and wedge delivery to an offline node); it
evicts the largest sender's oldest blob, so quota-stuffing only ever cycles
the stuffer's own blobs.

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
uses standalone signature proofs), rosters are **capped at 15 active
members** (enforced 2026-08-13 at invite mint and `circle/join` — checked
before the invite use is burned; re-pairs pass; a peer's signed over-cap
roster still imports rather than being mutilated, it just cannot grow),
per-member rate limits are **persisted**
so a restart cannot reset an attacker's budget, and missing-circle vs.
no-scope return identical errors (no circle-id oracle). Ledger forks freeze
the circle. Agent-authored content carries an explicit `agent_authored`
label (sender-asserted; honest-peer assumption for inbound). Member
**removal** is live (`circles.member.remove`, status → `left`, the A2A
boundary then refuses that member) and node-local by design — there is no
global revocation in a P2P circle; each member governs their own roster.
Since 2026-07-27 a removal also fans a **signed removal notice** to the
remaining members (a `circle/message` with a `system: "member_removed"`
marker, stored as a `system`-kind chat line, @agent summon suppressed on
receipt): informed consent, so the other humans learn of the eviction and
can prune their own rosters, while their nodes change nothing
automatically. The redundant `suspendMember` primitive was deleted the same
day (removal is already reversible via re-pair; legacy `suspended` rows
stay default-denied). Channel-key rotation on membership change remains
unbuilt: `key_epoch` blinds the gossip topic id (topic naming, not
encryption) and bumps only on member _add_. Until rotation lands, a removed
member can still read gossip-topic frames (which are unencrypted for any
mesh node anyway), and members who ignore the notice keep delivering to the
evictee — **the hard read-exclusion guarantee still requires rotation
(PLAN-36 §5.6)**. Outbound dials are SSRF-guarded (2026-08-13): every
peer-supplied a2a/mailbox URL passes `publicDialUrlError()` at the
`circleRpc` boundary — non-http(s) schemes, credentialed URLs, loopback,
RFC1918/CGNAT/link-local ranges, IPv4-mapped IPv6, and `.local`-class
hostnames are refused before any bytes leave the node
(`circles.dial.allowPrivate: true` opts out on trusted LANs; DNS rebinding
still needs resolver pinning and is a known follow-up).

## Gateway RPC surface

50 methods. Read-only methods (`status`, `list`, `messages`,
`tab.balances`, `disclosure.list`, `briefing`, `inviteInfo`, `canvas.list`,
`outbound.list`, `drafts.list`, `study.state`) need `operator.read`; every
mutating method needs `operator.write`. A drift test
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
- **Chat**: `circles.send`, `circles.messages` (paged: `limit` + keyset
  cursor `before` ms-epoch / `beforeId` tiebreak, so bursts sharing one
  millisecond are never skipped), `circles.markRead`, `circles.react`,
  `circles.pin`, `circles.message.delete`. `circles.list` rows carry
  `lastReadAt` (the UI freezes the "New" divider at open) and
  `pendingApprovals` (§5.3 approval counts for the rail + app-sidebar
  attention badges — an expiring approval is visible without the tab open;
  a headless app-wide sync keeps the counts fresh and never marks read).
- **Posture**: `circles.agentDrafts.set` — the chat header's posture chip
  is real (it reads your roster row) and clicking it flips the
  agent-drafts switch: persisted to the config file AND applied to the
  running service, with the response carrying the resulting posture so a
  node with no draft model wired honestly stays "off".
- **Canvas**: `circles.canvas.list`, `circles.canvas.put`,
  `circles.canvas.remove`, `circles.canvas.slice`
- **Tab**: `circles.tab.add`, `circles.tab.balances`, `circles.sync`
- **Ask & consent**: `circles.ask`, `circles.disclosure.set`,
  `circles.disclosure.list`
- **Study lens**: `circles.study.record`, `circles.study.state`
- **Agent**: `circles.drafts.list`, `circles.drafts.request`,
  `circles.drafts.publish`, `circles.drafts.discard`,
  `circles.outbound.list`, `circles.outbound.approve`,
  `circles.outbound.reject`
- **Briefing**: `circles.briefing`

## Built and deployed (status corrected 2026-08-13)

A stale version of this section cost two review passes real findings —
keep it honest. Live in production: the **guest-JOIN page**
(`https://join.bitterbot.ai/i/`, `deploy/guest-page/`, serving since
2026-07-15; now with in-browser Ed25519 invite verification) and the
**default mailbox host** (`https://mailbox.bitterbot.ai`,
`deploy/mailbox-host/`, Terraform'd). In-repo since 2026-08-13: the
**`bitterbot://` deep link** (Tauri shell registers the scheme;
`bitterbot://join#<code>` opens the invite panel prefilled and runs the
trust preview — ships with the next desktop build), the **SSRF dial
guard**, the **mailbox anti-wedge quotas**, and the **15-member cap**.

## Not built yet

The PARTICIPATING nodeless guest (guest tokens, escrowed votes/acks and
briefing reads, §6b compliance pack — the PLAN-36 §4 v4 launch GATE; the
live page is the canned floor), the PLAN-36 Phase 2 loop measurement gate
(no funnel instrumentation exists, and the click denominator needs a
privacy decision: the guest page deliberately has no analytics and the
code rides the URL fragment), the `circles.ask` ANSWER leg (granted asks
currently wait forever: no `kind:"answer"` composer path, no thread UI, no
agent answer action — surface or disable before advertising ask),
per-circle briefings (the compiled briefing is one node-wide digest; the
schema, cadence gate, and digest side-effect are all global),
message-history sync for late joiners (no `circle/messages.since` verb; a
fresh device has no chat history and `events.since` is a single capped
sweep), Phase 4 channels, chat-channel delivery of the briefing
(Telegram/Discord), the consented friend-of-friend graph and PeerMap
(Phase 6, no code), libp2p request-response transport with device↔PeerId
binding (Phase 5), shared-key confidentiality for the gossip topic (the
topic path is dark by default behind `circles.meshTopic.enabled` until
this lands), the hosted-node on-ramp, live guest chat, and everything
money: settlement, pooling, and mandates are gated behind counsel
sign-off and the constitutional wallet rule. (Circle-scoped polls and
share artifacts moved _out_ of this list: they shipped as Decision Cards
and the Co-Canvas.)
