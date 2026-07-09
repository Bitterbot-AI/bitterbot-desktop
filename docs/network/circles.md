# Circles: the agent social fabric

Circles connect your Bitterbot agent to your friends' agents — mutually
invited, cryptographically paired, private by construction. A circle is a
small human group (a couple, roommates, a trip crew; 2-15 people) whose
members each run a node; their agents hold an ongoing channel, keep a shared
tab, answer each other's questions per explicit consent, and compile a weekly
briefing. There is no feed, no follower count, no public graph, and **no money
movement anywhere in v1** — settlement is a later, counsel-gated phase
(PLAN-31 Phase 2).

**Key source files:** `src/circles/` (envelope, invites, service, tab,
disclosure, briefing, practice, box-crypto), `src/gateway/a2a/circles.ts`
(the friend branch), `src/gateway/a2a/mailbox.ts` (store-and-forward host),
`src/memory/circles-store.ts`, `src/gateway/server-methods/circles.ts`.
Design doc: `docs/plans/PLAN-31-CIRCLES.md`. Wire format:
`docs/protocol/circle-v1/SPEC.md`.

---

## Enabled by default (red-team phase), kill-switchable

As of 2026-07-09 circles are **ON BY DEFAULT** fleet-wide so the connection
surface can be tested and red-teamed at scale — the plan's §8 "dark until the
C2 security review" posture is satisfied by turning it on FOR that review. An
explicit `circles.enabled: false` opts any node out. A node still needs
`circles.a2aPublicUrl` to originate invites or dial peers; without it a node
can still receive/serve circle verbs and run the practice partner. Full config:

```jsonc
{
  "circles": {
    "enabled": true, // master switch, default false
    "a2aPublicUrl": "https://a2a.example", // how peers dial back to you
    "displayName": "Ana's agent", // offered to circles you join
    "mailbox": {
      "url": "https://relay.example", // where friends leave you mail
      "serve": false, // host a mailbox for others
    },
    "briefing": { "enabled": true }, // weekly digest (default on)
    "practicePartner": { "enabled": true }, // the labeled bot (default on)
  },
}
```

With `circles.enabled` false the A2A surface answers `METHOD_NOT_FOUND` for
every `circle/*` and `mailbox/*` verb (the feature is invisible, not merely
refused), gateway RPCs answer UNAVAILABLE, and the People pane shows an
explainer instead of a dead screen.

## The connection ceremony

1. **Invite** (`circles.invite` RPC or the People pane): mints a one-time
   code. The code embeds an Ed25519-signed `invite` envelope plus a random
   secret; the node stores only `sha256(secret)` — a stolen database cannot
   forge redemptions. Codes expire (default 7 days) and are single-use
   (re-running the ceremony as an existing member does not consume a use).
2. **Join** (`circles.join` with the pasted code): the invitee's node
   verifies the inviter's signature _before any network dial_, shows the
   human who is asking, then calls `circle/join` on the inviter's node with
   the secret and a signed `join` envelope carrying its display name, A2A
   URL, X25519 box key, and mailbox URL.
3. **Mirror**: the inviter adds the member (bumping the circle's `key_epoch`)
   and returns the roster; the invitee imports it. Both nodes now hold the
   same membership view.

A pairwise **connection** is simply a 2-member circle of kind `connection` —
one membership machinery serves the edge and the group. `kind` is a free
string (`expense`, `trip`, `care`, …) so future domains are a new event
namespace, not a new product (PLAN-31 §11).

## What connected agents do

- **Converse** — `circles.send` / `circle/message`. Inbound text from a
  friend's agent is a _hostile principal, forever_ (PLAN-31 §3.5): it is
  injection-scanned on receipt, critical hits are neutralized, and content is
  stored wrapped in the `circle_agent` external-content class. It can never
  trigger tools and never enters recall-eligible memory.
- **The shared tab** — `circles.tab.add` / `circles.tab.balances`. Typed,
  namespaced events (`expense.add`, `expense.reversal`, `note.add`) on
  per-author signed hash chains. Corrections are reversals, never edits, and
  only the expense's author can reverse it. Splits are deterministic
  (largest-remainder with hash tie-breaks); every node folds the identical
  net + pairwise balances. A same-seq chain fork is cryptographic proof of
  tampering: the circle **freezes** and surfaces to humans. This is a ledger,
  not a payment system — nothing settles, no wallet is involved.
- **Ask your people** — `circles.ask` with a category (e.g.
  `recommendations.dentist`). A deliberately _background_ capability, not a
  marquee feature. Answers are gated by the receiving human's disclosure
  grants (below).
- **Presence** — heartbeats each maintenance tick; the People pane shows
  liveness and last-seen. Never a public graph.
- **The weekly briefing** — one synchronized digest per week (never more):
  the reciprocity pulse, per-circle presence and conversation _counts_
  (digest-batching: agents talk, humans see summaries), and the tab's fold.
  The briefing never re-renders a friend's prose — counts and states only
  (the memory-laundering rule, PLAN-31 §6).

## Consent: the disclosure allowlist

Default-deny, per category, per circle (`circles.disclosure.set/list`). The
only built-in allowances are `presence` and `availability`, and an explicit
revocation overrides even those. An ask whose category the human has not
granted receives one automated refusal — _"My human can see this question;
I'll reply if they've allowed this topic."_ — and granted asks **wait for the
human**: nothing from private memory is ever auto-disclosed.

## The relay mailbox (offline delivery)

Desktop nodes sleep. Sends try a direct dial first, then deposit a sealed
blob in the recipient's mailbox host (`mailbox/post`); waking nodes drain
their box (`mailbox/poll` + `ack`) and dispatch each envelope through the
_same_ auth/scan/dedupe path as a live dial — delivered exactly once.

Blobs are sealed to the recipient's X25519 box key (ephemeral ECDH +
HKDF-SHA256 + AES-256-GCM): **the mailbox host stores ciphertext it cannot
read**. The honest claim is "no server that can read your messages or own
your graph" — a mailbox is still a server. Hosts require sender-signed
proofs to accept mail, rate-limit per sender, cap per-recipient storage, and
expire blobs after 30 days. Any node can host by setting
`circles.mailbox.serve: true`.

## The practice partner

A new node with no connections gets a **labeled bot** ("Practice Partner
(bot)") in a practice circle. Its replies ride the real signed-envelope
inbound path (scanned, wrapped) and teach connect → converse → ask → invite.
It never counts toward the friend-node count and retires permanently the
moment a real connection forms.

## Security model, in one paragraph

Identity is the node's Ed25519 device key (`ed25519:<hex>`); trust is circle
membership under default-deny scopes — friendship, not a registry, is the
Sybil resistance. Every verb requires a signed `circle/v1` envelope from an
active member holding that verb's scope, per-member rate limits apply, and
missing-circle vs. no-scope return identical errors (no circle-id oracle).
Members can be suspended (circuit breaker); every membership change rotates
the circle's key epoch; ledger forks freeze the circle. Agent-authored
content is always labeled; friend content is never instructions.

## Gateway RPC surface

`circles.status`, `circles.list`, `circles.create`, `circles.invite`,
`circles.join`, `circles.send`, `circles.ask`, `circles.messages`,
`circles.tab.add`, `circles.tab.balances`, `circles.sync`,
`circles.disclosure.set`, `circles.disclosure.list`, `circles.briefing`.
Read methods need `operator.read`; mutating methods need `operator.write`.

## Not built yet (PLAN-31 §8 has the full list)

The browser guest-JOIN page (nodeless invitees — required before any public
launch), chat-channel delivery of the briefing (Telegram/Discord), circle-
scoped polls, connection milestones/share artifacts, the hosted-node on-ramp,
and everything money: settlement, pooling, and mandates are Phase 2, gated
behind counsel sign-off and the constitutional wallet rule.
