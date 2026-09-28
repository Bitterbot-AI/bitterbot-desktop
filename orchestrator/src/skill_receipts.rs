//! Distinct-skill accounting for received skill gossip.
//!
//! `SecurityManager` dedupes by content hash, which stops byte-identical
//! re-broadcasts. It cannot stop a publisher that re-sends the same skill with
//! slightly different bytes each time (the legacy dream-crystal publisher does
//! exactly this: same UUID name, the crystal's current text). Counting every
//! such message as a "skill received", and rewarding the sender's reputation
//! for each, inflated both: one peer's 5 skills showed up as 314 received.
//!
//! This tracker answers "have we already seen this author publish a skill with
//! this name?" so stats and reputation count skills, not messages. Every
//! message is still forwarded to Node, which decides whether a new version of a
//! known skill is legitimate.

use lru::LruCache;
use std::num::NonZeroUsize;

pub const RECEIPT_CACHE_CAP: usize = 10_000;

pub struct SkillReceiptTracker {
    seen: LruCache<(String, String), ()>,
}

impl SkillReceiptTracker {
    pub fn new(capacity: usize) -> Self {
        Self {
            seen: LruCache::new(NonZeroUsize::new(capacity.max(1)).expect("capacity >= 1")),
        }
    }

    /// Record a received skill. Returns true the first time this author is
    /// seen publishing this skill name (case- and whitespace-insensitive).
    pub fn record(&mut self, author_pubkey: &str, name: &str) -> bool {
        let key = (author_pubkey.to_string(), name.trim().to_lowercase());
        self.seen.put(key, ()).is_none()
    }
}

impl Default for SkillReceiptTracker {
    fn default() -> Self {
        Self::new(RECEIPT_CACHE_CAP)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_a_skill_once_per_author_and_name() {
        let mut t = SkillReceiptTracker::new(16);
        assert!(t.record("alice", "e03d582d-53dc"));
        // Same skill re-sent (different bytes upstream): not new.
        assert!(!t.record("alice", "e03d582d-53dc"));
        assert!(!t.record("alice", "  E03D582D-53DC "));
        // Different skill from the same author, or same name from another author: new.
        assert!(t.record("alice", "other-skill"));
        assert!(t.record("bob", "e03d582d-53dc"));
    }

    #[test]
    fn bounded_memory_forgets_the_least_recent() {
        let mut t = SkillReceiptTracker::new(2);
        assert!(t.record("a", "one"));
        assert!(t.record("a", "two"));
        assert!(t.record("a", "three")); // evicts "one"
        assert!(t.record("a", "one"));
        assert!(!t.record("a", "three"));
    }
}
