# PLAN-32: Fleet Sync — signed, quorum-authorized config (and later code) distribution

**Status:** DRAFT v1 (2026-07-10). Built from two adversarially-verified
research passes (deep-research harness, 103 + 106 agents, primary-source
verification; folklore excluded). **Config-push is the buildable Phase 1 and
the whole near-term point; code-push is designed here but deliberately
deferred as a separate program with a real operational cost.**
**Depends on:** the management-node quorum (genesis trust list + Ed25519
management key, `p2p.genesisTrustListPath`, `p2p.tier: "management"`, live
since 2026-03-25), the orchestrator gossip control plane
(`orchestrator-bridge.ts` `sendCommand` + libp2p pubsub — the same rail that
already carries `propagate_ban` / `sign_as_management` / `publish_*`), the
config-defaults + config-reload layers (`src/config/defaults.ts`,
`src/config/io.ts`, `src/gateway/config-reload.ts`), and the local ingestion
gates (PLAN-15 curator + staging, PLAN-13 capability gating + skill-injection
scanner).

## 0. Thesis

Give the fleet a "Windows Update for nodes" that **survives the two threats
that matter**: (1) a **stolen signing key** must not be able to push anything
to the fleet, and (2) a **validly-signed-but-malicious payload** (a bad
config value, or a backdoored build) must be **contained, detectable, and
reversible**. The insight from the research is that **no single control
covers both threats**, so Fleet Sync is a layered stack, and the layers a
config change needs are a strict subset of what a code change needs. That
asymmetry is the plan: ship the safe, cheap config layer first; treat code
distribution as a later, heavier program.

**What exists today (the starting line).** A management node whose pubkey is
in the DNS-bootstrapped genesis trust list can _broadcast_ signed content over
gossip (bans, management-signed skills, weather, bounties, telemetry), and
every receiver verifies the signature against the trust list. There is
deliberately **no remote code execution and no remote config mutation**; code
rollout is pull-based self-update from a git/npm channel
(`bitterbot update`, `update.checkOnStart`). Fleet Sync keeps pull-based
_delivery_ (no push-RCE path, ever) and adds **quorum-signed assertions** that
nodes verify before acting on.

**The single most important design principle (verified).** The system is
built on the explicit TUF assumption that private keys _will_ be compromised;
the goal is not to prevent key theft but to make one stolen key **useless on
its own**. That is why every authority in Fleet Sync is a **threshold of the
quorum**, never a single key.

## 1. The three orthogonal control families

Each defends exactly one threat and is, by design, useless against the other
(all verified 3-0 from primary sources across the two passes):

| Family                                                                                                                                | Defends                                                                                                                 | Does NOT defend                                                                                         | Primary source                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Threshold signing** (TUF/Uptane role-separation + M-of-N per role + offline root; FROST/RFC 9591 as the aggregate-signature option) | A single stolen key: an attacker with < threshold keys cannot produce trusted metadata                                  | A validly-signed **malicious payload** (bad config, backdoored build)                                   | TUF spec + FAQ + security docs; Uptane standard; RFC 9591                |
| **Reproducible builds + independent multi-party rebuild attestation** (Bitcoin-Core-Guix / Debian / SLSA / in-toto)                   | A backdoor injected at **build/distribution** time (SolarWinds/SUNSPOT class: signed with a valid cert, shipped anyway) | A backdoor **already in the reviewed source**; RB proves "binary matches source," not "source is clean" | reproducible-builds.org; Lamb & Zacchiroli (arXiv 2104.06020); SLSA v1.2 |
| **Witnessed transparency log** (append-only Merkle, CT/RFC 6962 lineage → Rekor / Go sumdb)                                           | _Detecting_ a maliciously- or selectively-served payload after the fact                                                 | Anything, unless monitors **actively watch**; it is tamper-**evident**, not tamper-**proof**            | RFC 6962; Sigstore security docs; transparency-dev/witness               |

Two over-strong claims were **refuted 0-3** by the verifier and must not creep
into the design: (a) "reproducible builds prove there is no backdoor" — they
do not, they only bind binary to source; (b) "trust the checksum ≥50% of
builders agree on" — no naive majority rule; authority is always a **named
threshold**, never "most of the internet."

**The blast-radius asymmetry that drives the phasing.** A **config flag** is a
value drawn from a _typed allowlist with bounded ranges_ — a malicious but
validly-signed config can, at worst, toggle a switch you already ship a kill
switch for; it can never introduce new behavior or a backdoor. A **code
update** is arbitrary RCE by definition and drags in the entire build/supply-
chain threat surface (the thing signing alone explicitly does not cover). So
config-push needs only family 1; code-push needs all three plus containment.

## 2. Trust model: the genesis quorum becomes a threshold root

The existing ~5-pubkey genesis trust list _is_ a TUF-style root role waiting to
happen. Fleet Sync formalizes it:

- **Root threshold M-of-N.** A Fleet Sync assertion is valid only if signed by
  **M of the N** genesis-quorum keys (start `3-of-5`). One stolen key is below
  threshold and does nothing. Below-threshold compromise is repaired by normal
  in-band rotation (the quorum signs a new root listing updated keys); only
  compromise of a _threshold_ of root keys forces out-of-band recovery.
- **Offline / online split.** The high-value signing (the keys that authorize
  _what may exist_) is kept offline; a lower-value **freshness/timestamp** key
  may be online for automated liveness. A stolen _online_ key cannot install
  anything, but note (verified) it _can_ cause a **freeze / rollback denial-of-
  service** — so the freshness path is protected too, not just the content path.
- **v1 signing = plain Ed25519 multisig** (M independent signatures over a
  canonical assertion), because every node already speaks Ed25519 and the
  quorum is tiny. **FROST/RFC 9591** (a single aggregate threshold signature
  that hides the threshold and shrinks the payload) is a v2 upgrade, not a v1
  requirement — it adds a distributed-key-generation + signing-round protocol
  we do not need yet. Do not conflate the two: TUF "threshold" = M independent
  sigs; FROST = one aggregate sig. Both give M-of-N authorization.

## 3. Phase 1 — Config-push (the MVP; this is the near-term deliverable)

A **signed, quorum-authorized, typed, bounded, reversible** feature-flag /
config channel. No build artifact, so families 2 and 3 do not even apply — the
whole reproducible-build / supply-chain surface is absent. This is the safe way
to do exactly what we did by hand for `circles.enabled`, at fleet scale.

**The assertion.** A `FleetConfigAssertion` is a canonical JSON object:

```jsonc
{
  "protocol": "fleet-config/v1",
  "seq": 42, // monotonic release counter (anti-rollback)
  "issued_at": 1783900000,
  "expires_at": 1784504800, // freshness bound (see §5 offline nodes)
  "changes": [
    // ONLY typed-allowlist keys, bounded values
    { "key": "circles.enabled", "value": true },
    { "key": "circles.maxTasksPerMinute", "value": 12 },
  ],
  "cohort": { "type": "all" }, // or {percent} / {named cohort} — §5
  "signatures": [
    /* >= M genesis-quorum Ed25519 sigs over the preimage */
  ],
}
```

**The typed allowlist is the security boundary.** A registry maps each
push-able key to a validator: type + bounded range + an "is this safe to set
remotely" flag. `circles.enabled: boolean`; `x.threshold: number 0.0–1.0`;
`a2a.maxTasksPerMinute: int 0–1000`. **Anything not in the registry is
rejected**, and any value outside its bound is rejected, _before_ the change is
applied — so even a fully-valid-signed assertion cannot set an arbitrary key or
an out-of-range value. Money-touching, wallet, and key-material config is
**permanently excluded** from the allowlist (there is nothing to gain by
letting the fleet channel move those).

**Verification pipeline on each node (all local, fail-closed):**

1. `signatures.length >= M` and each verifies against a _current_ genesis
   trust-list key. (< M → reject, this is the stolen-key defense.)
2. `seq > last_applied_seq` (anti-rollback) and `now < expires_at` (freshness).
3. Every `changes[].key` is in the typed allowlist and every value is in
   bounds. (Reject the whole assertion on any violation — no partial apply.)
4. Cohort match (§5). If not in the target cohort, record but do not apply.
5. Apply as a **virtual config overlay** merged _under_ the node's explicit
   local config, so an **explicit local setting always wins** (the local kill
   switch is absolute — a node operator can always pin `circles.enabled: false`
   and the fleet cannot override it). Persist the applied `seq` for anti-
   rollback.

**Delivery = existing gossip, pull-shaped.** Assertions ride the orchestrator
pubsub rail (a new `fleet-config/v1` topic next to `bitterbot/bounties/v1`);
nodes also fetch the latest signed assertion on wake (pull) so a long-offline
node catches up. No node ever _executes_ anything received — it verifies an
assertion and toggles a known flag.

**Hot-reload, not restart.** Config-flag changes must apply live. Register
`fleet-config` (and the specific pushed prefixes) in
`config-reload.ts`'s rule table as `kind: "hot"` so an applied assertion does
_not_ trigger a full gateway restart. (This also fixes the papercut we hit
enabling circles by hand, where any `circles.*` edit self-restarted the
gateway.)

**Why this is safe even against a validly-signed-malicious assertion:** the
worst an attacker with M keys can do is set an allowlisted flag to an in-bounds
value — e.g. flip a feature on/off fleet-wide. That is bounded, instantly
reversible by the next assertion (or a local pin), never new behavior, and
never a backdoor. And getting M keys already means the quorum itself is
compromised, which is the out-of-band-recovery event, not a routine risk.

## 4. Phase 2 — Detection (witnessed transparency log)

Adds tamper-evidence so a _quorum-signed but malicious_ assertion (or, later, a
code release) is **publicly detectable** and cannot be shown to only some nodes
(the split-view / equivocation attack).

- Every issued assertion is appended to an **append-only Merkle log**; the log
  publishes signed tree heads (checkpoints) with inclusion + consistency
  proofs. Nodes verify their assertion's inclusion proof against a checkpoint.
- **Split-view is the real risk** (verified): a misbehaving log could show
  "good" assertions to auditors and a malicious one to a victim node. The
  defense is **witnesses** — independent parties that cosign a checkpoint _only
  after_ verifying it is append-only relative to the last one — plus **gossip**
  of checkpoints over the libp2p mesh so nodes cross-check they all see the same
  head. Robust prevention needs a **witness quorum** (~2f+1), not one witness.
- Good news (verified, and a correction to older papers): the "CT gossip is not
  deployed" problem of 2018–19 has since matured (`transparency-dev/witness`,
  the C2SP tlog-witness spec), so the witness-quorum-over-gossip layer — the
  no-central-server part that fits us perfectly — is genuinely buildable in 2026.

**Honest limit:** a transparency log is worthless unless someone **actively
monitors** it. We must budget for persistent auditors (see §11).

## 5. Phase 3 — Containment and reversibility

- **Staged rollout / canary cohorts.** An assertion targets `all`, a
  `percent`, or a `named cohort` first. With no central rollout controller,
  cohort health is self-reported over gossip and widening is gated on a **time
  delay** plus absence of freeze signals, not on a central observer.
- **Asymmetric emergency stop.** Pushing needs **M-of-N**; a **freeze / pause**
  needs only **1** quorum member (or a low threshold). This is deliberate: it
  must always be far easier to halt propagation than to start it. A freeze is
  itself a signed, gossiped assertion that pins nodes to their last-applied
  `seq`.
- **Reversibility.** Config: the next assertion (higher `seq`) reverts a flag;
  a local pin overrides immediately. Code (Phase 4): A/B dual-slot with
  automatic rollback on failed health/boot (the Android-A/B pattern).
- **Anti-rollback for the intermittently-online.** `seq` is monotonic and
  `expires_at` bounds staleness; the open tuning question is the expiry cadence
  that avoids _both_ a long-offline node false-freezing on stale metadata _and_
  a rollback window — witnessed checkpoints gossiped P2P are the freshness
  anchor with no central timestamp server.

## 6. Phase 4+ — Code-push (designed, deferred, honestly a program)

Code-push is achievable and safe, but only as the **full CHAINIAC-shaped
stack**, and its hard cost is operational, not cryptographic.

**The blueprint (verified exemplar): CHAINIAC** (Nikitin et al., USENIX
Security 2017). Witness servers collectively cosign a release **only if** (a) a
_threshold_ of developer signatures is present **and** (b) independent
witnesses verify **source→binary reproducibility**; root of trust is an
**offline** key, with built-in **timestamping** for update-timeliness. That is
families 1 + 2 + 3 fused. **Bitcoin Core's Guix builds** are the shipping
real-world instance: multiple maintainers deterministically rebuild each
release to bit-identical output and each signs the hash, so "the binary is
honest" is a multi-party attestation.

**The Fleet Sync code channel would be:**

1. **Two-repo split (Uptane Director/Image analog).** An offline-quorum-signed
   set of _approved target hashes_ (what may exist) + an online Director
   assertion (what each cohort should run). A node installs only when the
   online selection **matches** an offline-signed target — so the online push
   authority alone can never install arbitrary code. (Verified: Uptane requires
   compromising _both_ to install an arbitrary malicious image.)
2. **Reproducible builds + ≥2 independent rebuilder attestations** before a
   target hash is quorum-signed (closes the backdoored-build gap signing
   cannot; SLSA/in-toto provenance records how it was built). Remember the
   refuted claim: this binds binary to source, it does **not** prove the source
   is clean — source review stays a separate human gate.
3. **Transparency log** (§4) over every target + provenance, witnessed.
4. **A/B dual-slot install with auto-rollback** and staged cohorts (§5).
5. **Delivery stays pull** (git/npm channel), gated by the above verification —
   never a push that executes.

**Why deferred:** the crypto is a few weeks; the **reproducible-build pipeline
plus an always-on witness/rebuilder/auditor fleet** is the real program, and
that operational burden — not broken math — is what sank real deployments
(Docker Notary's TUF was sound; its operational complexity killed adoption).
Build code-push only _after_ Phase 1 has exercised the quorum + gossip + anti-
rollback plumbing on the target where a mistake cannot ship a backdoor.

## 7. What comparable systems actually ship

**Verified this pass (cite-able):** CHAINIAC (threshold cosigning +
reproducibility + offline root + timestamping); Bitcoin Core Guix multi-signer
deterministic builds; Debian reproducible builds; Go checksum database
(sum.golang.org / Trillian — consistency, not authorship); Sigstore Rekor +
cosign (signature transparency, auditability contingent on monitors); SLSA
provenance + in-toto (build-track integrity, explicitly not source/dependency/
distribution). RFC 6962 CT as the append-only-log lineage.

**Known but NOT verified this run (flagged, not asserted):** Docker Content
Trust / Notary v1 operational-complexity postmortem; PyPI PEP 458/480; crates.
io; automotive Uptane in production (aktualizr / Torizon / Automotive Grade
Linux); edge-OTA fleets (Mender / balena / RAUC / SWUpdate / Eclipse hawkBit);
P2P/IPFS/blockchain-anchored OTA. A targeted third research pass would turn
this into a verified comparables table if we want it before committing to
code-push.

## 8. Mapping to existing components

| Fleet Sync piece             | Existing component                                                                       | Add / change                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quorum root (M-of-N)         | genesis trust list (`p2p.genesisTrustListPath`, orchestrator `management_pubkey` verify) | Add a threshold check + canonical assertion signing/verify (reuse the `commerce/envelope.ts` domain-prefixed Ed25519 pattern with a `fleet-config/v1` prefix). |
| Signed broadcast rail        | orchestrator gossip (`sendCommand`, `propagate_ban`, `publish_*`)                        | New `fleet-config/v1` pubsub topic + a `publish_config_assertion` verb; receive-and-verify path.                                                               |
| Typed flag allowlist         | `src/config/defaults.ts` + config schema (zod)                                           | New registry: key → {type, bounds, remotely-settable}. Reject-by-default.                                                                                      |
| Apply as overlay, local wins | `loadConfig` chain in `io.ts`                                                            | Merge the verified overlay _under_ explicit local config; persist applied `seq`.                                                                               |
| Hot-reload, no restart       | `config-reload.ts` `BASE_RELOAD_RULES`                                                   | Register pushed prefixes as `kind: "hot"`.                                                                                                                     |
| Last-line defense            | PLAN-15 curator/staging, PLAN-13 capability gating + injection scanner                   | Unchanged; config-push carries no code, so these apply only to the Phase-4 code channel.                                                                       |
| Transparency witness/gossip  | libp2p pubsub                                                                            | New Merkle log + witnessed checkpoints gossiped on-mesh (Phase 2).                                                                                             |

## 9. Build order and non-goals

**Order:** (P1) config-push MVP — allowlist registry, assertion sign/verify,
overlay apply, gossip topic, hot-reload, local-pin override, anti-rollback
`seq`. Ships the real "flip a flag fleet-wide, safely" capability. → (P2)
witnessed transparency log. → (P3) staged cohorts + asymmetric freeze. → (P4+)
code channel (two-repo + reproducible-build attestation + A/B rollback), only
after the auditor/witness commitment is made.

**Non-goals (v1):** no remote code execution; no arbitrary remote config (only
the typed bounded allowlist); no central server; no money/wallet/key config on
the channel, ever; no FROST until v2. Every phase lands wired, kill-switched
(the whole channel has a local disable + a quorum freeze), tested, and
documented in the same commit (standing rule).

## 10. Risk register

- **Quorum key theft below threshold** → nothing happens (that is the point);
  repair by in-band rotation. Threshold-or-more theft → out-of-band root
  re-issuance; this is the designed catastrophic-recovery path, not a routine
  risk.
- **Validly-signed-malicious config** → bounded to an allowlisted in-range flip,
  reversible, no backdoor; a local pin overrides immediately.
- **Stolen online freshness key** → cannot install, _can_ freeze/rollback-DoS;
  mitigate by keeping freshness lower-privilege and the quorum able to rotate it.
- **Split-view / equivocation** → witnessed checkpoints + mesh gossip; needs a
  witness quorum, not one witness.
- **Nobody watches the log** (the killer) → detection is theatre without active
  monitors; Phase 2 must fund persistent auditors or it is not real.
- **Operational complexity** (what actually kills these systems) → config-first
  keeps P1 cheap; do not start the code program without owning its ongoing cost.
- **Long-offline node** → stale-metadata false-freeze vs rollback window; tune
  `expires_at` cadence against witnessed-checkpoint freshness (open question).

## Appendix A: research provenance

Two deep-research passes (2026-07-09/10), primary-source adversarial
verification. Pass 1 (103 agents) verified the authorization layer:
TUF/Uptane role separation + per-role M-of-N thresholds + offline root
(theupdateframework.io, uptane.org), FROST/RFC 9591, Uptane Director+Image
two-repo split, release-counter anti-rollback. Pass 2 (106 agents) verified
the detection/containment layers and refuted two over-strong claims:
transparency logs detect-not-prevent and require active monitors (RFC 6962,
Sigstore), split-view needs witnessed checkpoints + gossip
(transparency-dev/witness), reproducible builds + independent multi-party
rebuild close the build-integrity gap but do not prove source is clean
(reproducible-builds.org, arXiv 2104.06020, SLSA v1.2), and CHAINIAC (USENIX
Security 2017) as the fused blueprint. Under-verified this run and flagged as
open: the product-by-product comparables table (§7) and the offline-node
freshness-cadence tuning (§5). All numbers/claims flagged folklore by the
verifiers are excluded.
