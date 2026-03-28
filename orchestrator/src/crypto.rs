use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use tracing::info;

use crate::swarm::SkillEnvelope;

// Re-export for use in sign_bounty/verify_bounty
use serde_json;

/// Load an Ed25519 keypair from disk, or generate a new one.
/// Compatible with the Python PEM format used in ai-engine/keys/.
pub fn load_or_generate_keypair(
    key_dir: &Path,
) -> Result<SigningKey, Box<dyn std::error::Error>> {
    fs::create_dir_all(key_dir)?;
    let priv_path = key_dir.join("node.key");
    let pub_path = key_dir.join("node.pub");

    if priv_path.exists() {
        // Try to load raw 32-byte seed first, then fall back to PEM parsing
        let key_bytes = fs::read(&priv_path)?;
        if key_bytes.len() == 32 {
            let signing_key = SigningKey::from_bytes(&key_bytes.try_into().map_err(|_| "invalid key length")?);
            info!("Loaded existing Ed25519 keypair from {:?}", key_dir);
            return Ok(signing_key);
        }
        // For PEM format, extract the 32-byte seed from PKCS8 DER
        let pem_str = String::from_utf8_lossy(&key_bytes);
        if pem_str.contains("PRIVATE KEY") {
            let der = pem_to_der(&pem_str)?;
            // PKCS8 Ed25519 private key: the seed is the last 32 bytes of the inner key
            if der.len() >= 32 {
                let seed_start = der.len() - 32;
                let seed: [u8; 32] = der[seed_start..].try_into()?;
                let signing_key = SigningKey::from_bytes(&seed);
                info!("Loaded existing Ed25519 keypair (PEM) from {:?}", key_dir);
                return Ok(signing_key);
            }
        }
        return Err("unable to parse Ed25519 private key".into());
    }

    // Generate new keypair
    let mut rng = rand::thread_rng();
    let signing_key = SigningKey::generate(&mut rng);
    let verifying_key = signing_key.verifying_key();

    // Save as raw 32-byte seed (compact format)
    fs::write(&priv_path, signing_key.to_bytes())?;
    fs::write(&pub_path, verifying_key.to_bytes())?;

    info!("Generated new Ed25519 keypair in {:?}", key_dir);
    Ok(signing_key)
}

pub fn peer_id_from_keypair(keypair: &SigningKey) -> libp2p::PeerId {
    let pk = keypair.verifying_key();
    let libp2p_pk = libp2p::identity::PublicKey::from(
        libp2p::identity::ed25519::PublicKey::try_from_bytes(&pk.to_bytes())
            .expect("valid ed25519 public key"),
    );
    libp2p::PeerId::from_public_key(&libp2p_pk)
}

/// Sign a skill payload and produce a SkillEnvelope for gossip transmission.
pub fn sign_skill(
    signing_key: &SigningKey,
    local_peer_id: &libp2p::PeerId,
    skill_md_base64: &str,
    skill_name: &str,
) -> SkillEnvelope {
    let skill_bytes = base64::engine::general_purpose::STANDARD
        .decode(skill_md_base64)
        .unwrap_or_else(|_| skill_md_base64.as_bytes().to_vec());

    let signature: Signature = signing_key.sign(&skill_bytes);
    let content_hash = hex::encode(Sha256::digest(&skill_bytes));

    let verifying_key = signing_key.verifying_key();

    SkillEnvelope {
        version: 1,
        skill_md: skill_md_base64.to_string(),
        name: skill_name.to_string(),
        author_peer_id: local_peer_id.to_string(),
        author_pubkey: base64::engine::general_purpose::STANDARD.encode(verifying_key.to_bytes()),
        signature: base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        content_hash,
        stable_skill_id: None,
        skill_version: None,
        previous_content_hash: None,
        tags: None,
        category: None,
        management_signature: None,
        management_pubkey: None,
    }
}

/// Verify a skill envelope's Ed25519 signature.
pub fn verify_skill(envelope: &SkillEnvelope) -> bool {
    let pubkey_bytes = match base64::engine::general_purpose::STANDARD.decode(&envelope.author_pubkey)
    {
        Ok(b) => b,
        Err(_) => return false,
    };
    let pubkey_array: [u8; 32] = match pubkey_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let verifying_key = match VerifyingKey::from_bytes(&pubkey_array) {
        Ok(vk) => vk,
        Err(_) => return false,
    };

    let sig_bytes = match base64::engine::general_purpose::STANDARD.decode(&envelope.signature) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let sig_array: [u8; 64] = match sig_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let signature = Signature::from_bytes(&sig_array);

    let skill_bytes = base64::engine::general_purpose::STANDARD
        .decode(&envelope.skill_md)
        .unwrap_or_else(|_| envelope.skill_md.as_bytes().to_vec());

    // Verify content hash
    let expected_hash = hex::encode(Sha256::digest(&skill_bytes));
    if expected_hash != envelope.content_hash {
        return false;
    }

    verifying_key.verify(&skill_bytes, &signature).is_ok()
}

/// Verify a raw Ed25519 signature (base64 sig, base64 pubkey, raw data bytes).
pub fn verify_raw_signature(sig_b64: &str, pubkey_b64: &str, data: &[u8]) -> bool {
    let pubkey_bytes = match base64::engine::general_purpose::STANDARD.decode(pubkey_b64) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let pubkey_array: [u8; 32] = match pubkey_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let verifying_key = match VerifyingKey::from_bytes(&pubkey_array) {
        Ok(vk) => vk,
        Err(_) => return false,
    };

    let sig_bytes = match base64::engine::general_purpose::STANDARD.decode(sig_b64) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let sig_array: [u8; 64] = match sig_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let signature = Signature::from_bytes(&sig_array);

    verifying_key.verify(data, &signature).is_ok()
}

/// Sign skill content as a management node (endorsement signature).
pub fn sign_as_management(signing_key: &SigningKey, skill_md_b64: &str) -> (String, String) {
    let skill_bytes = base64::engine::general_purpose::STANDARD
        .decode(skill_md_b64)
        .unwrap_or_else(|_| skill_md_b64.as_bytes().to_vec());
    let signature: Signature = signing_key.sign(&skill_bytes);
    (
        base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().to_bytes()),
    )
}

/// Verify a management node's endorsement signature on a skill.
pub fn verify_management_signature(sig_b64: &str, pubkey_b64: &str, skill_md_b64: &str) -> bool {
    let skill_bytes = base64::engine::general_purpose::STANDARD
        .decode(skill_md_b64)
        .unwrap_or_else(|_| skill_md_b64.as_bytes().to_vec());
    verify_raw_signature(sig_b64, pubkey_b64, &skill_bytes)
}

/// Sign a weather payload. Signs over canonical JSON: {"c":N,"d":N,"r":"..."}
pub fn sign_weather(signing_key: &SigningKey, cortisol: f64, duration_ms: u64, reason: &str) -> (String, String) {
    let canonical = format!(
        r#"{{"c":{},"d":{},"r":"{}"}}"#,
        cortisol, duration_ms, reason.replace('"', r#"\""#)
    );
    let signature: Signature = signing_key.sign(canonical.as_bytes());
    (
        base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().to_bytes()),
    )
}

/// Verify a weather envelope's management signature.
pub fn verify_weather(envelope: &crate::swarm::WeatherEnvelope) -> bool {
    let canonical = format!(
        r#"{{"c":{},"d":{},"r":"{}"}}"#,
        envelope.global_cortisol_spike, envelope.duration_ms,
        envelope.reason.replace('"', r#"\""#)
    );
    verify_raw_signature(&envelope.management_signature, &envelope.management_pubkey, canonical.as_bytes())
}

/// Sign a bounty payload for gossipsub propagation.
pub fn sign_bounty(
    signing_key: &SigningKey, bounty_id: &str, target_type: &str,
    description: &str, priority: f64, reward_multiplier: f64, expires_at: u64,
) -> (String, String) {
    let canonical = serde_json::json!({
        "bounty_id": bounty_id, "target_type": target_type, "description": description,
        "priority": priority, "reward_multiplier": reward_multiplier, "expires_at": expires_at,
    }).to_string();
    let signature: Signature = signing_key.sign(canonical.as_bytes());
    (
        base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().to_bytes()),
    )
}

/// Verify a bounty envelope's management signature.
pub fn verify_bounty(envelope: &crate::swarm::BountyEnvelope) -> bool {
    let canonical = serde_json::json!({
        "bounty_id": envelope.bounty_id, "target_type": envelope.target_type,
        "description": envelope.description, "priority": envelope.priority,
        "reward_multiplier": envelope.reward_multiplier, "expires_at": envelope.expires_at,
    }).to_string();
    verify_raw_signature(&envelope.management_signature, &envelope.management_pubkey, canonical.as_bytes())
}

/// Sign a telemetry signal. Signs canonical JSON: {"d":<data>,"t":"<type>"}
pub fn sign_telemetry(
    signing_key: &SigningKey,
    signal_type: &str,
    data: &serde_json::Value,
) -> (String, String) {
    let canonical = serde_json::json!({"d": data, "t": signal_type}).to_string();
    let signature: Signature = signing_key.sign(canonical.as_bytes());
    (
        base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().to_bytes()),
    )
}

/// Verify a telemetry envelope's author signature.
pub fn verify_telemetry(envelope: &crate::swarm::TelemetryEnvelope) -> bool {
    let canonical = serde_json::json!({"d": envelope.data, "t": envelope.signal_type}).to_string();
    verify_raw_signature(&envelope.signature, &envelope.author_pubkey, canonical.as_bytes())
}

/// Sign a query for network broadcast. Signs canonical JSON: {"id":"<id>","q":"<query>"}
pub fn sign_query(
    signing_key: &SigningKey,
    query_id: &str,
    query: &str,
) -> (String, String) {
    let canonical = serde_json::json!({"id": query_id, "q": query}).to_string();
    let signature: Signature = signing_key.sign(canonical.as_bytes());
    (
        base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().to_bytes()),
    )
}

/// Verify a query envelope's author signature.
pub fn verify_query(envelope: &crate::swarm::QueryEnvelope) -> bool {
    let canonical = serde_json::json!({"id": envelope.query_id, "q": envelope.query}).to_string();
    verify_raw_signature(&envelope.signature, &envelope.author_pubkey, canonical.as_bytes())
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let lines: Vec<&str> = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    let b64 = lines.join("");
    Ok(base64::engine::general_purpose::STANDARD.decode(b64)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_keypair_generation_and_loading() {
        let dir = TempDir::new().unwrap();
        let key1 = load_or_generate_keypair(dir.path()).unwrap();
        let key2 = load_or_generate_keypair(dir.path()).unwrap();
        assert_eq!(key1.to_bytes(), key2.to_bytes());
    }

    #[test]
    fn test_sign_and_verify() {
        let dir = TempDir::new().unwrap();
        let keypair = load_or_generate_keypair(dir.path()).unwrap();
        let peer_id = peer_id_from_keypair(&keypair);

        let skill_md = base64::engine::general_purpose::STANDARD.encode(b"# Test Skill\nHello");
        let envelope = sign_skill(&keypair, &peer_id, &skill_md, "test-skill");

        assert!(verify_skill(&envelope));
        assert_eq!(envelope.name, "test-skill");
        assert_eq!(envelope.version, 1);
    }

    #[test]
    fn test_verify_rejects_tampered() {
        let dir = TempDir::new().unwrap();
        let keypair = load_or_generate_keypair(dir.path()).unwrap();
        let peer_id = peer_id_from_keypair(&keypair);

        let skill_md = base64::engine::general_purpose::STANDARD.encode(b"# Test Skill");
        let mut envelope = sign_skill(&keypair, &peer_id, &skill_md, "test-skill");
        envelope.skill_md = base64::engine::general_purpose::STANDARD.encode(b"# Tampered");

        assert!(!verify_skill(&envelope));
    }
}
