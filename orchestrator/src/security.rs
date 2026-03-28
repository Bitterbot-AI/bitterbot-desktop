use crate::crypto;
use crate::swarm::SkillEnvelope;
use lru::LruCache;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::time::Instant;
use tracing::warn;

const MAX_SKILL_SIZE_BYTES: usize = 256 * 1024; // 256KB
const MAX_SKILLS_PER_MINUTE_PER_PEER: usize = 10;
const MAX_TELEMETRY_PER_MINUTE_PER_PEER: usize = 5;
const MAX_QUERIES_PER_MINUTE_PER_PEER: usize = 3;
const RATE_WINDOW_SECS: u64 = 60;
const DEDUP_CACHE_CAP: usize = 10_000;
/// Timestamp tolerance: reject messages older than 5 min or more than 1 min in the future.
const TIMESTAMP_WINDOW_PAST_SECS: u64 = 300;
const TIMESTAMP_WINDOW_FUTURE_SECS: u64 = 60;

pub struct SecurityValidator {
    /// Per-peer rate limiting for skills: peer_id -> list of timestamps
    rate_limits: HashMap<String, Vec<Instant>>,
    /// Per-peer rate limiting for telemetry signals
    telemetry_rate_limits: HashMap<String, Vec<Instant>>,
    /// Per-peer rate limiting for queries
    query_rate_limits: HashMap<String, Vec<Instant>>,
    /// Content-hash dedup LRU cache
    seen_hashes: LruCache<String, ()>,
    /// Genesis trust list: base64 Ed25519 pubkeys of authorized management nodes.
    genesis_trust_list: Vec<String>,
}

impl SecurityValidator {
    pub fn new(genesis_trust_list: Vec<String>) -> Self {
        Self {
            rate_limits: HashMap::new(),
            telemetry_rate_limits: HashMap::new(),
            query_rate_limits: HashMap::new(),
            seen_hashes: LruCache::new(NonZeroUsize::new(DEDUP_CACHE_CAP).unwrap()),
            genesis_trust_list,
        }
    }

    /// Validate a timestamp (in seconds) is within the acceptable window.
    pub fn validate_timestamp_secs(&self, timestamp: u64) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        timestamp + TIMESTAMP_WINDOW_PAST_SECS >= now && timestamp <= now + TIMESTAMP_WINDOW_FUTURE_SECS
    }

    /// Validate a timestamp (in milliseconds) is within the acceptable window.
    pub fn validate_timestamp_ms(&self, timestamp: u64) -> bool {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        timestamp + (TIMESTAMP_WINDOW_PAST_SECS * 1000) >= now_ms
            && timestamp <= now_ms + (TIMESTAMP_WINDOW_FUTURE_SECS * 1000)
    }

    /// Check if a pubkey belongs to a management node (is in genesis trust list).
    pub fn is_management_pubkey(&self, pubkey: &str) -> bool {
        self.genesis_trust_list.contains(&pubkey.to_string())
    }

    /// Validate an incoming skill envelope. Returns true if the envelope
    /// passes all security checks.
    pub fn validate_envelope(&mut self, envelope: &SkillEnvelope) -> bool {
        // 1. Content-length check
        if envelope.skill_md.len() > MAX_SKILL_SIZE_BYTES {
            warn!(
                "Rejected skill from {}: payload too large ({} bytes)",
                envelope.author_peer_id,
                envelope.skill_md.len()
            );
            return false;
        }

        // 2. Timestamp window check
        if !self.validate_timestamp_secs(envelope.timestamp) {
            warn!(
                "Rejected skill from {}: stale/future timestamp (ts={})",
                envelope.author_peer_id, envelope.timestamp
            );
            return false;
        }

        // 3. Signature verification
        if !crypto::verify_skill(envelope) {
            warn!(
                "Rejected skill from {}: invalid signature",
                envelope.author_peer_id
            );
            return false;
        }

        // 4. Content-hash dedup
        if self.seen_hashes.contains(&envelope.content_hash) {
            warn!(
                "Rejected skill from {}: duplicate content hash {}",
                envelope.author_peer_id, envelope.content_hash
            );
            return false;
        }

        // 5. Per-peer rate limiting
        if !self.check_rate_limit(&envelope.author_peer_id) {
            warn!(
                "Rejected skill from {}: rate limit exceeded",
                envelope.author_peer_id
            );
            return false;
        }

        // All checks passed - record this hash
        self.seen_hashes.put(envelope.content_hash.clone(), ());

        true
    }

    /// Check per-peer telemetry rate limit. Returns true if allowed.
    pub fn check_telemetry_rate(&mut self, peer_id: &str) -> bool {
        Self::generic_rate_check(&mut self.telemetry_rate_limits, peer_id, MAX_TELEMETRY_PER_MINUTE_PER_PEER)
    }

    /// Check per-peer query rate limit. Returns true if allowed.
    pub fn check_query_rate(&mut self, peer_id: &str) -> bool {
        Self::generic_rate_check(&mut self.query_rate_limits, peer_id, MAX_QUERIES_PER_MINUTE_PER_PEER)
    }

    fn generic_rate_check(
        limits: &mut HashMap<String, Vec<Instant>>,
        peer_id: &str,
        max_per_window: usize,
    ) -> bool {
        let now = Instant::now();
        let timestamps = limits.entry(peer_id.to_string()).or_default();
        timestamps.retain(|ts| now.duration_since(*ts).as_secs() < RATE_WINDOW_SECS);
        if timestamps.len() >= max_per_window {
            return false;
        }
        timestamps.push(now);
        true
    }

    fn check_rate_limit(&mut self, peer_id: &str) -> bool {
        let now = Instant::now();
        let timestamps = self.rate_limits.entry(peer_id.to_string()).or_default();

        // Remove entries older than the rate window
        timestamps.retain(|ts| now.duration_since(*ts).as_secs() < RATE_WINDOW_SECS);

        if timestamps.len() >= MAX_SKILLS_PER_MINUTE_PER_PEER {
            return false;
        }

        timestamps.push(now);
        true
    }

    /// Validate management signature if present. Returns true if valid OR if no management sig present.
    /// If invalid: strips the management fields from the envelope (prevent propagating forged claims).
    pub fn validate_management_signature(&self, envelope: &mut SkillEnvelope) -> bool {
        let (Some(sig), Some(pubkey)) = (&envelope.management_signature, &envelope.management_pubkey) else {
            return true; // no management sig, that's fine
        };
        if !self.genesis_trust_list.contains(pubkey) {
            warn!("Management pubkey not in genesis trust list, stripping");
            envelope.management_signature = None;
            envelope.management_pubkey = None;
            return true; // still accept the skill, just not verified
        }
        if !crypto::verify_management_signature(sig, pubkey, &envelope.skill_md) {
            warn!("Invalid management signature, stripping");
            envelope.management_signature = None;
            envelope.management_pubkey = None;
        }
        true // never reject the entire skill for a bad management sig
    }

    /// Prune old rate-limit entries to prevent unbounded memory growth.
    pub fn prune(&mut self) {
        let now = Instant::now();
        let prune_window = RATE_WINDOW_SECS * 2;
        for limits in [&mut self.rate_limits, &mut self.telemetry_rate_limits, &mut self.query_rate_limits] {
            limits.retain(|_, timestamps| {
                timestamps.retain(|ts| now.duration_since(*ts).as_secs() < prune_window);
                !timestamps.is_empty()
            });
        }
    }
}
