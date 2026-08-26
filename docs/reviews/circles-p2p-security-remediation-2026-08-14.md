# Circles P2P Transport — Security Remediation Plan (Stages 2–4)

**LOCAL / UNTRACKED — do not commit while CRITICAL items are open.** This
enumerates live, unfixed vulnerabilities in a public repo; publishing it is
disclosure. Delete or move to a private tracker once B3/B5 land.

Source: adversarial pass 2026-08-14 (3 read-only agents, one per stage). Full
finding detail in the agent transcripts + `project_circles_p2p_security_pass`
memory. This doc is the ACTION plan: what to fix, in what order, why, and the
Stage-4 sign-off bar.

## Status snapshot

- **DONE + pushed (`c150141`):** CRIT-1 latch mis-fire, HIGH-6 refused
  conflation, HIGH-3 crash vector, M1 GCM auth-tag/IV downgrade, and B0
  (`circles.p2pDial` default OFF). These were confirmed, self-contained, and
  needed no orchestrator release.
- **Live exposure remaining:** (1) supply-chain updater is unsigned NOW; (2)
  mesh-ingress has no rate limit — mitigated for the request path by B0
  (p2pDial off), but the gossip-topic path (meshTopic) has the same gap and is
  also default-off, so neither is reachable until explicitly enabled. The
  supply-chain item is the only finding exploitable against the deployed fleet
  today.

## Remediation batches (priority order)

### B5 — Supply chain (do FIRST; only live-fleet-exploitable critical). Effort M–L.

The updater (`deploy/relay-fleet/`) installs the newest `orchestrator-v*`
release after a same-origin checksum, no signature. Mutable GitHub assets +
floating action tags = anyone who can push a tag or replace an asset gets
unattended code exec on all 3 relays within 24h.

1. **Sign `checksums.txt` in CI** — cosign keyless (OIDC, no key custody) or
   minisign. Embed the public key / identity in `update-orchestrator.sh` +
   cloud-init; make verify a HARD precondition of install (C1).
2. **SHA-pin all third-party actions** in `orchestrator-release.yml`
   (`softprops/action-gh-release`, `Swatinem/rust-cache`, etc.) (C1).
3. **Version floor + no-downgrade + prerelease filter** in the updater:
   `select(.prerelease==false)`, semver sort (not GitHub date order), refuse a
   version lower than installed (C2).
4. **Canary + health probe + rollback:** keep `$BIN.prev`, `systemctl is-active`
   - an RPC probe after restart, auto-revert on failure; stagger the 3 relays
     by region so one leads by a day (C6).
5. **Harden the update unit:** add `User=`, `NoNewPrivileges`, `ProtectSystem`
   (runs as root today) (C6). Paginate the releases query / alert on repeated
   updater failure (C10). Single-source the script (cloud-init curls it from a
   pinned commit, or a CI diff-check) (C12).
6. **First-boot: stop building `main` as root.** Install the signed release
   binary at boot instead of `cargo build` of mutable HEAD; if the build must
   stay, `--locked` + unprivileged user (C13).
   > Design call for Victor: cosign-keyless vs minisign (key custody). Keyless
   > needs no secret but ties trust to the GitHub OIDC identity; minisign is a
   > held key. Recommend cosign keyless + a documented identity.

### B3 — Mesh-ingress rate limiting (unblocks turning p2pDial/meshTopic ON). Effort M.

Two agents independently: the rate limiter runs AFTER the membership check, so
it never fires for a non-member, and `circle/join` writes `circle_rate_hits`
BEFORE the existence check on an attacker-chosen bucket key. Same gap on both
the gossip-topic path and the request-response path.

1. **Per-`from_peer_id` token bucket at BOTH mesh ingress points, BEFORE
   dispatch:** the Rust circle-topic arm (reuse `self.security.check_*_rate`
   like telemetry/queries do) and the request_response arm; TS-side, a bucket
   in `startCircleP2pTransport`'s callback and the topic-transport handler
   before `resolveCirclesDb` (Stage2 H1, Stage4 CRIT-2). Noise-auth makes
   `from_peer_id` a trustworthy bucket key — use it.
2. **Verb allowlist per transport:** the gossip-topic path should NOT dispatch
   request/response verbs (`circle/join`, `circle/roster`, `circle/events.since`)
   — those belong on the P2P/HTTP legs. Drop them in `receiveCircleFrame`
   (Stage2 H2).
3. **Reorder `rateLimited` after the circle-existence check** in
   `handleCircleJoin` so a bogus circle_id can't force a DB write (Stage2 H2 /
   Stage4 CRIT-2).
4. **Global in-flight semaphore** on inbound P2P dispatch; cheapen the reject
   path by checking the known-method set before `resolveCirclesDb` (Stage4 LOW-9).
5. Then flip `p2pDial` (and, after B6 encryption-honesty, `meshTopic`) default
   back ON. **This is the gate for that.** Needs an orchestrator release
   (v0.2.3) since the Rust arms change — bundle with B4.

### B4 — Relay hardening (bundle into the v0.2.3 release with B3). Effort M.

1. **Tighten `is_circle_topic`** to the exact shape (`len==91`, 64-hex segment) —
   kills the unbounded-topic OOM + amplification (C4) and the degenerate/path
   forms (C5). Apply at all three enforcement points.
2. **Per-peer carriage quota** (e.g. 16 topics/peer) + a reserved partition for
   topics that have carried ≥1 message, so a flood can't evict proven-live
   circles (C3). Add tests — carriage shipped untested.
3. **Gate `unsubscribe_topic`** with `is_circle_topic` (it can currently detach
   core topics) and chmod the IPC socket 0600 (C7).
4. Bound the relay-to-relay carriage contagion (only carry topics announced by
   non-relay peers, or a hop counter) (C8).
5. Cap `inbound_circle_rpc` map size + sweep every ~5s + apply backpressure to
   the event forwarder so a flood can't leak held channels (Stage4 HIGH-4).

### B6 — Honesty + docs (cheap, do alongside B3/B4). Effort S.

1. Correct the overclaiming comments: rotation-completeness (M2 — rotation is
   one-sided vaporware today), at-rest parity (M6 — DB is NOT chmod'd while
   box.json is), and the stale "not encrypted" headers (L6).
2. Document the **metadata exposure** honestly in `circle-gossip.md`: relays
   see topic id + sender pubkey (cleartext in the wrapper) + timing = the
   social graph, even though content is encrypted. Add the missing Stage-3
   carriage section. Demote the carriage INFO log to debug/hashed (C9).
3. Set a date to **reject legacy plaintext frames** (`meshTopic.requireEncrypted`)
   — encryption is unenforceable while plaintext is accepted (L1).

### B7 — Deeper / lower-priority (schedule after the above). Effort M each.

- **Forward secrecy + key lifecycle:** age/volume rotation trigger, purge
  retired own-keys, and add `circle_sender_keys`/`circle_own_sender_keys` to
  `deleteCircle` (they survive circle deletion today) (M5).
- **Replay counters:** monotonic `(circle,sender,keyId)` counter in the AAD +
  receiver high-water mark; dedupe presence/sender_key (dedupe covers only 3 of
  9 verbs, presence is replayable to roll back endpoints) (M3).
- **peer_id challenge-response:** require a signed-nonce proof before honoring a
  new `peer_id`; reject collisions; clear on removal. Today it's an unverified
  self-claim enabling attacker-directed dialing + false delivery receipts
  (Stage4 MED-7). Victim-poisoning is already blocked (writes keyed by signed
  author) — this closes the self-blackhole / false-receipt surface.
- **Box-identity safety:** split load (throw on unparseable) from create so a
  corrupt `box.json` can't be silently regenerated by a remote request (M4).
- **Windows IPC auth:** the TCP 19002 listener has no auth (PRE-EXISTING, not a
  Stage-4 regression, but Stage 4 widens its impact) — named pipe DACL or a
  per-boot shared secret (Stage4 HIGH-5).
- **sender_key flood cap** (M7), chmod circles DB 0600 (M6), `events.since`
  response byte-cap (LOW-11), epoch-1 fallback in `resolveTopicCircle` (L2),
  index `sealed[self]` + assert `wrapper.s==author` (L3/L4).

## Sequencing rationale

1. **B5 first** — it's the only finding exploitable against the deployed fleet
   _today_, and its blast radius (root on all relays → fleet identity + DHT
   bootstrap) dwarfs everything else.
2. **B3 + B4 + (Rust bits of) B7 HIGH-4 as one v0.2.3 release** — they all touch
   the orchestrator, and B3 is the gate that lets p2pDial/meshTopic turn back
   on. Reconverge relays via the (now-signed, post-B5) updater.
3. **B6 alongside** — cheap, and the honesty fixes should ship before anyone
   re-enables the mesh on the strength of the current docs.
4. **B7 remainder** — real but not blocking; schedule after the mesh is safely
   back on.

## Stage-4 (and Stage 2/3) sign-off bar

Do NOT mark the transport plan "complete" until: B5 shipped + relays on a signed
binary; B3 shipped + p2pDial/meshTopic safely re-enabled behind the rate
limiter; B4 relay hardening in the same release; B6 docs honest; and a LIVE
two-node verification (two NAT'd nodes on v0.2.3, encrypted mesh delivery +
URL-free join, HTTP fallback proven) per PLAN-35 A2.x. B7 items can trail with
tracked issues.
