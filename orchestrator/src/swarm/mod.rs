pub mod http;

use base64::Engine as _;
use crate::crypto;
use crate::ipc::IpcCommand;
use crate::security::SecurityValidator;
use ed25519_dalek::SigningKey;
use futures::StreamExt as _;
use libp2p::{
    autonat,
    dcutr,
    gossipsub::{self, MessageAuthenticity, ValidationMode},
    identify,
    kad::{self, store::MemoryStore},
    noise, relay, tcp, yamux, Multiaddr, PeerId, SwarmBuilder,
    swarm::behaviour::toggle::Toggle,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

/// Gossipsub topic for skill propagation.
pub const SKILLS_TOPIC: &str = "bitterbot/skills/v1";
/// Gossipsub topic for telemetry data.
pub const TELEMETRY_TOPIC: &str = "bitterbot/telemetry/v1";
/// Gossipsub topic for hormonal weather broadcasts.
pub const WEATHER_TOPIC: &str = "bitterbot/weather/v1";
/// Gossipsub topic for global curriculum bounties.
pub const BOUNTIES_TOPIC: &str = "bitterbot/bounties/v1";
/// Gossipsub topic for peer-to-peer knowledge queries.
pub const QUERIES_TOPIC: &str = "bitterbot/queries/v1";

/// Maximum payload size for gossipsub messages (256KB).
const MAX_GOSSIPSUB_MSG_SIZE: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillEnvelope {
    pub version: u32,
    pub skill_md: String, // base64
    pub name: String,
    pub author_peer_id: String,
    pub author_pubkey: String, // base64
    pub signature: String,     // base64
    pub timestamp: u64,
    pub content_hash: String, // sha256 hex
    // Optional versioning fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stable_skill_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub management_signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub management_pubkey: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherEnvelope {
    pub global_cortisol_spike: f64,
    pub duration_ms: u64,
    pub reason: String,
    pub management_pubkey: String,
    pub management_signature: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BountyEnvelope {
    pub bounty_id: String,
    pub target_type: String,
    pub description: String,
    pub priority: f64,
    pub reward_multiplier: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region_hint: Option<String>,
    pub expires_at: u64,
    pub management_pubkey: String,
    pub management_signature: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryEnvelope {
    pub signal_type: String,
    pub data: serde_json::Value,
    pub author_peer_id: String,
    pub author_pubkey: String,
    pub signature: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryEnvelope {
    pub query_id: String,
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_hint: Option<String>,
    pub author_peer_id: String,
    pub author_pubkey: String,
    pub signature: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerDetail {
    pub addrs: Vec<String>,
    pub connected_at: u64,
    #[serde(default)]
    pub skills_received_from: u64,
    #[serde(default)]
    pub reputation_score: f64,
    #[serde(default)]
    pub tier: String,
    #[serde(default)]
    pub tier_verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmStats {
    pub peer_id: String,
    pub connected_peers: usize,
    pub skills_published: u64,
    pub skills_received: u64,
    pub uptime_secs: u64,
    pub peer_details: HashMap<String, PeerDetail>,
    pub listen_addrs: Vec<String>,
    // Gossipsub mesh health
    pub mesh_peers_count: usize,
    pub subscribed_topics: Vec<String>,
}

pub type SharedStats = Arc<Mutex<SwarmStats>>;

// ── Management Node Analytics ─────────────────────────────────────────────

/// Network-wide aggregated state maintained only by management-tier nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagementState {
    /// Total unique peers ever seen by this management node.
    pub total_peers_seen: u64,
    /// Current peer count by tier (e.g., {"edge": 5, "management": 2}).
    pub peers_by_tier: HashMap<String, usize>,
    /// Rolling window of peer snapshots for trend analysis.
    pub peer_snapshots: Vec<PeerSnapshot>,
    /// Telemetry event counts by signal_type.
    pub telemetry_counts_by_type: HashMap<String, u64>,
    /// Rolling window of telemetry records (last 30 minutes).
    pub telemetry_window: Vec<TelemetryRecord>,
    /// Total skills published across the network.
    pub skills_published_network_wide: u64,
    /// Per-peer skill publication count in current window.
    pub skills_per_peer_window: HashMap<String, u64>,
    /// Economic activity signals.
    pub economic_signals: Vec<EconomicSignal>,
    /// Active anomaly alerts.
    pub anomaly_alerts: Vec<AnomalyAlert>,
    /// Network health score (0.0 - 1.0).
    pub network_health_score: f64,
    /// Timestamp of last census run.
    pub last_census_at: u64,
    /// Historical peer counts for trend analysis.
    pub peer_count_history: Vec<(u64, usize)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerSnapshot {
    pub peer_id: String,
    pub tier: String,
    pub tier_verified: bool,
    pub skills_received_from: u64,
    pub reputation_score: f64,
    pub connected_at: u64,
    pub snapshot_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryRecord {
    pub signal_type: String,
    pub author_peer_id: String,
    pub timestamp: u64,
    pub data_summary: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EconomicSignal {
    pub peer_id: String,
    pub signal_type: String,
    pub amount_usdc: f64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnomalyAlert {
    pub alert_type: String,
    pub severity: String,
    pub peer_ids: Vec<String>,
    pub description: String,
    pub detected_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_action: Option<String>,
}

pub type SharedManagementState = Arc<Mutex<ManagementState>>;

impl ManagementState {
    pub fn new() -> Self {
        Self {
            total_peers_seen: 0,
            peers_by_tier: HashMap::new(),
            peer_snapshots: Vec::new(),
            telemetry_counts_by_type: HashMap::new(),
            telemetry_window: Vec::new(),
            skills_published_network_wide: 0,
            skills_per_peer_window: HashMap::new(),
            economic_signals: Vec::new(),
            anomaly_alerts: Vec::new(),
            network_health_score: 1.0,
            last_census_at: 0,
            peer_count_history: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub enum SwarmEvent {
    SkillReceived(SkillEnvelope),
    WeatherReceived(WeatherEnvelope),
    BountyReceived(BountyEnvelope),
    TelemetryReceived(TelemetryEnvelope),
    QueryReceived(QueryEnvelope),
    PeerConnected(PeerId, Vec<Multiaddr>),
    PeerDisconnected(PeerId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayMode {
    Off,
    Client,
    Server,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NatStatus {
    Unknown,
    Public,
    Private,
}

/// Combined libp2p behaviour for the Bitterbot network.
#[derive(libp2p::swarm::NetworkBehaviour)]
pub struct BitterbotBehaviour {
    pub gossipsub: gossipsub::Behaviour,
    pub kademlia: kad::Behaviour<MemoryStore>,
    pub autonat: autonat::v2::client::Behaviour,
    pub identify: identify::Behaviour,
    pub relay_client: Toggle<relay::client::Behaviour>,
    pub relay_server: Toggle<relay::Behaviour>,
    pub dcutr: Toggle<dcutr::Behaviour>,
}

pub struct SwarmHandle {
    signing_key: SigningKey,
    local_peer_id: PeerId,
    stats: SharedStats,
    security: SecurityValidator,
    swarm: libp2p::Swarm<BitterbotBehaviour>,
    skills_topic: gossipsub::IdentTopic,
    telemetry_topic: gossipsub::IdentTopic,
    weather_topic: gossipsub::IdentTopic,
    bounties_topic: gossipsub::IdentTopic,
    queries_topic: gossipsub::IdentTopic,
    /// Channel for forwarding swarm events to Node.js via the IPC layer.
    ipc_event_tx: mpsc::UnboundedSender<serde_json::Value>,
    genesis_trust_list: Vec<String>,
    node_tier: String,
    /// Management-only aggregated state. None for edge nodes.
    management_state: Option<SharedManagementState>,
    /// Current NAT status detected by AutoNAT.
    nat_status: NatStatus,
    /// Relay servers to request reservations from when behind NAT.
    relay_server_addrs: Vec<(Multiaddr, PeerId)>,
    /// Whether we have an active relay reservation.
    has_relay_reservation: bool,
    /// Relay mode configuration.
    relay_mode: RelayMode,
}

impl SwarmHandle {
    pub fn stats(&self) -> SharedStats {
        Arc::clone(&self.stats)
    }

    pub fn management_state(&self) -> Option<SharedManagementState> {
        self.management_state.as_ref().map(Arc::clone)
    }

    /// Send a JSON-line event to the IPC event stream (consumed by Node.js).
    fn emit_ipc_event(&self, event: serde_json::Value) {
        if let Err(e) = self.ipc_event_tx.send(event) {
            debug!("IPC event channel closed (no receiver): {}", e);
        }
    }

    /// Run periodic management census — snapshot all peers, compute tier distribution.
    fn run_management_census(&self) {
        let Some(ref mgmt) = self.management_state else { return };
        let stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
        let mut state = mgmt.lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Snapshot peers by tier
        state.peers_by_tier.clear();
        for (peer_id, detail) in &stats.peer_details {
            let tier = if detail.tier.is_empty() { "unknown" } else { &detail.tier };
            *state.peers_by_tier.entry(tier.to_string()).or_insert(0) += 1;

            state.peer_snapshots.push(PeerSnapshot {
                peer_id: peer_id.clone(),
                tier: detail.tier.clone(),
                tier_verified: detail.tier_verified,
                skills_received_from: detail.skills_received_from,
                reputation_score: detail.reputation_score,
                connected_at: detail.connected_at,
                snapshot_at: now,
            });
        }

        // Cap snapshot history
        if state.peer_snapshots.len() > 10_000 {
            let drain = state.peer_snapshots.len() - 10_000;
            state.peer_snapshots.drain(0..drain);
        }

        // Track peer count history for trend analysis
        state.peer_count_history.push((now, stats.connected_peers));
        if state.peer_count_history.len() > 1440 {
            let drain_count = state.peer_count_history.len() - 1440;
            state.peer_count_history.drain(0..drain_count);
        }

        state.total_peers_seen = state.total_peers_seen.max(stats.connected_peers as u64);
        state.last_census_at = now;

        drop(state);
        drop(stats);

        // Emit census event to IPC
        self.emit_ipc_event(serde_json::json!({
            "type": "management_census",
            "payload": {
                "timestamp": now,
                "connected_peers": self.stats.lock().unwrap_or_else(|e| e.into_inner()).connected_peers,
            }
        }));
    }

    /// Run anomaly detection — rate spikes, peer drops, sybil patterns.
    fn run_anomaly_detection(&self) {
        let Some(ref mgmt) = self.management_state else { return };
        let stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
        let mut state = mgmt.lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let mut alerts: Vec<AnomalyAlert> = Vec::new();

        // 1. Sudden peer drop detection (>30% drop from 10min average)
        let recent_counts: Vec<usize> = state.peer_count_history.iter()
            .filter(|(ts, _)| *ts > now.saturating_sub(600))
            .map(|(_, c)| *c)
            .collect();
        if !recent_counts.is_empty() {
            let avg = recent_counts.iter().sum::<usize>() as f64 / recent_counts.len() as f64;
            let current = stats.connected_peers as f64;
            if avg > 2.0 && current < avg * 0.7 {
                alerts.push(AnomalyAlert {
                    alert_type: "peer_drop".to_string(),
                    severity: if current < avg * 0.5 { "high" } else { "medium" }.to_string(),
                    peer_ids: vec![],
                    description: format!(
                        "Peer count dropped from avg {:.0} to {} ({:.0}% drop)",
                        avg, stats.connected_peers, (1.0 - current / avg) * 100.0
                    ),
                    detected_at: now,
                    auto_action: None,
                });
            }
        }

        // 2. Skill publication rate spike per peer
        for (peer_id, count) in &state.skills_per_peer_window {
            if *count > 20 {
                alerts.push(AnomalyAlert {
                    alert_type: "rate_spike".to_string(),
                    severity: if *count > 50 { "high" } else { "medium" }.to_string(),
                    peer_ids: vec![peer_id.clone()],
                    description: format!("Peer {} published {} skills in window", peer_id, count),
                    detected_at: now,
                    auto_action: None,
                });
            }
        }

        // 3. Sybil cluster detection — many new peers in short time
        let recent_connections: Vec<&PeerSnapshot> = state.peer_snapshots.iter()
            .filter(|s| s.connected_at > now.saturating_sub(60))
            .collect();
        if recent_connections.len() > 10 {
            alerts.push(AnomalyAlert {
                alert_type: "sybil_cluster".to_string(),
                severity: "high".to_string(),
                peer_ids: recent_connections.iter().map(|s| s.peer_id.clone()).collect(),
                description: format!("{} new peers in last 60 seconds", recent_connections.len()),
                detected_at: now,
                auto_action: None,
            });
        }

        // Reset per-window counters
        state.skills_per_peer_window.clear();

        // Store alerts
        state.anomaly_alerts.extend(alerts.clone());
        if state.anomaly_alerts.len() > 100 {
            let drain = state.anomaly_alerts.len() - 100;
            state.anomaly_alerts.drain(0..drain);
        }

        // Compute network health score
        let peer_stability = if !recent_counts.is_empty() {
            let avg = recent_counts.iter().sum::<usize>() as f64 / recent_counts.len() as f64;
            if avg > 0.0 { (stats.connected_peers as f64 / avg).min(1.0) } else { 1.0 }
        } else {
            1.0
        };
        let critical_count = alerts.iter().filter(|a| a.severity == "high" || a.severity == "critical").count();
        let anomaly_absence = (1.0 - critical_count as f64 / 10.0).max(0.0);
        state.network_health_score = 0.4 * peer_stability + 0.3 * anomaly_absence + 0.3;

        drop(state);
        drop(stats);

        // Emit anomaly alerts to IPC
        for alert in &alerts {
            self.emit_ipc_event(serde_json::json!({
                "type": "management_anomaly",
                "payload": alert
            }));
        }
    }

    /// Aggregate telemetry into management state (called on each telemetry receive).
    fn aggregate_telemetry(&self, envelope: &TelemetryEnvelope) {
        let Some(ref mgmt) = self.management_state else { return };
        let mut state = mgmt.lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        *state.telemetry_counts_by_type
            .entry(envelope.signal_type.clone())
            .or_insert(0) += 1;

        state.telemetry_window.push(TelemetryRecord {
            signal_type: envelope.signal_type.clone(),
            author_peer_id: envelope.author_peer_id.clone(),
            timestamp: envelope.timestamp,
            data_summary: envelope.data.clone(),
        });

        // Prune window to last 30 minutes
        let cutoff = now.saturating_sub(1800);
        state.telemetry_window.retain(|t| t.timestamp > cutoff);
    }

    /// Track skill publication rate for management anomaly detection.
    fn track_skill_publication(&self, author_peer_id: &str) {
        let Some(ref mgmt) = self.management_state else { return };
        let mut state = mgmt.lock().unwrap_or_else(|e| e.into_inner());
        state.skills_published_network_wide += 1;
        *state.skills_per_peer_window
            .entry(author_peer_id.to_string())
            .or_insert(0) += 1;
    }

    pub async fn run_event_loop(
        &mut self,
        mut ipc_rx: mpsc::UnboundedReceiver<IpcCommand>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let start = std::time::Instant::now();
        let mut prune_interval = tokio::time::interval(Duration::from_secs(120));
        prune_interval.tick().await; // skip immediate first tick
        let mut bootstrap_interval = tokio::time::interval(Duration::from_secs(300));
        bootstrap_interval.tick().await; // skip immediate first tick

        // Management node periodic intervals (only active for management tier)
        let mut census_interval = tokio::time::interval(Duration::from_secs(60));
        census_interval.tick().await;
        let mut anomaly_interval = tokio::time::interval(Duration::from_secs(300));
        anomaly_interval.tick().await;
        let is_management = self.management_state.is_some();

        // Relay reservation renewal (45 min, before the 1-hour expiry)
        let mut relay_renewal_interval = tokio::time::interval(Duration::from_secs(2700));
        relay_renewal_interval.tick().await;

        loop {
            tokio::select! {
                Some(cmd) = ipc_rx.recv() => {
                    self.handle_ipc_command(cmd).await;
                }
                event = self.swarm.select_next_some() => {
                    use libp2p::swarm::SwarmEvent as LibSwarmEvent;
                    match event {
                        LibSwarmEvent::Behaviour(behaviour_event) => {
                            self.handle_behaviour_event(behaviour_event).await;
                        }
                        LibSwarmEvent::ConnectionEstablished {
                            peer_id,
                            endpoint,
                            ..
                        } => {
                            let addr = endpoint.get_remote_address().clone();
                            self.handle_swarm_event(SwarmEvent::PeerConnected(
                                peer_id,
                                vec![addr],
                            ))
                            .await;
                        }
                        LibSwarmEvent::ConnectionClosed {
                            peer_id,
                            ..
                        } => {
                            // Only emit disconnect if the peer has no remaining connections
                            if !self.swarm.is_connected(&peer_id) {
                                self.handle_swarm_event(SwarmEvent::PeerDisconnected(peer_id))
                                    .await;
                            }
                        }
                        LibSwarmEvent::NewListenAddr { address, .. } => {
                            info!("Listening on {}", address);
                            let mut stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                            if !stats.listen_addrs.contains(&address.to_string()) {
                                stats.listen_addrs.push(address.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(10)) => {
                    // Update uptime and mesh stats periodically
                    let mut stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                    stats.uptime_secs = start.elapsed().as_secs();
                    stats.mesh_peers_count = self.swarm
                        .behaviour()
                        .gossipsub
                        .all_mesh_peers()
                        .count();
                    stats.subscribed_topics = self.swarm
                        .behaviour()
                        .gossipsub
                        .topics()
                        .map(|t| t.to_string())
                        .collect();
                }
                _ = prune_interval.tick() => {
                    self.security.prune();
                }
                _ = bootstrap_interval.tick() => {
                    info!("Triggering periodic Kademlia bootstrap");
                    let _ = self.swarm.behaviour_mut().kademlia.bootstrap();
                }
                _ = census_interval.tick(), if is_management => {
                    self.run_management_census();
                }
                _ = anomaly_interval.tick(), if is_management => {
                    self.run_anomaly_detection();
                }
                _ = relay_renewal_interval.tick(), if self.relay_mode == RelayMode::Client => {
                    if self.has_relay_reservation && !self.relay_server_addrs.is_empty() {
                        info!("Renewing relay reservations");
                        self.has_relay_reservation = false; // Force re-reservation
                        self.initiate_relay_reservations();
                    }
                }
                _ = tokio::signal::ctrl_c() => {
                    info!("Received shutdown signal");
                    break;
                }
            }
        }

        Ok(())
    }

    async fn handle_behaviour_event(&mut self, event: BitterbotBehaviourEvent) {
        match event {
            BitterbotBehaviourEvent::Gossipsub(gossipsub::Event::Message {
                propagation_source,
                message_id,
                message,
            }) => {
                let topic_str = message.topic.to_string();
                debug!(
                    "Gossipsub message from {} on topic {} (id: {})",
                    propagation_source, topic_str, message_id
                );

                if topic_str == SKILLS_TOPIC {
                    match serde_json::from_slice::<SkillEnvelope>(&message.data) {
                        Ok(envelope) => {
                            self.handle_swarm_event(SwarmEvent::SkillReceived(envelope)).await;
                        }
                        Err(e) => {
                            warn!(
                                "Failed to deserialize skill envelope from {}: {}",
                                propagation_source, e
                            );
                        }
                    }
                } else if topic_str == WEATHER_TOPIC {
                    match serde_json::from_slice::<WeatherEnvelope>(&message.data) {
                        Ok(envelope) => {
                            self.handle_swarm_event(SwarmEvent::WeatherReceived(envelope)).await;
                        }
                        Err(e) => warn!("Failed to deserialize weather envelope: {}", e),
                    }
                } else if topic_str == BOUNTIES_TOPIC {
                    match serde_json::from_slice::<BountyEnvelope>(&message.data) {
                        Ok(envelope) => {
                            self.handle_swarm_event(SwarmEvent::BountyReceived(envelope)).await;
                        }
                        Err(e) => warn!("Failed to deserialize bounty envelope: {}", e),
                    }
                } else if topic_str == TELEMETRY_TOPIC {
                    match serde_json::from_slice::<TelemetryEnvelope>(&message.data) {
                        Ok(envelope) => {
                            self.handle_swarm_event(SwarmEvent::TelemetryReceived(envelope)).await;
                        }
                        Err(e) => warn!("Failed to deserialize telemetry envelope: {}", e),
                    }
                } else if topic_str == QUERIES_TOPIC {
                    match serde_json::from_slice::<QueryEnvelope>(&message.data) {
                        Ok(envelope) => {
                            self.handle_swarm_event(SwarmEvent::QueryReceived(envelope)).await;
                        }
                        Err(e) => warn!("Failed to deserialize query envelope: {}", e),
                    }
                }
            }
            BitterbotBehaviourEvent::Gossipsub(gossipsub::Event::Subscribed {
                peer_id,
                topic,
            }) => {
                debug!("Peer {} subscribed to {}", peer_id, topic);
            }
            BitterbotBehaviourEvent::Gossipsub(gossipsub::Event::Unsubscribed {
                peer_id,
                topic,
            }) => {
                debug!("Peer {} unsubscribed from {}", peer_id, topic);
            }
            BitterbotBehaviourEvent::Kademlia(kad::Event::RoutingUpdated {
                peer, addresses, ..
            }) => {
                debug!(
                    "Kademlia routing updated: peer {} with {} addresses",
                    peer,
                    addresses.len()
                );
            }
            BitterbotBehaviourEvent::Kademlia(kad::Event::OutboundQueryProgressed {
                result,
                ..
            }) => {
                debug!("Kademlia query progress: {:?}", result);
            }
            BitterbotBehaviourEvent::Identify(identify::Event::Received {
                peer_id, info, ..
            }) => {
                debug!(
                    "Identify: peer {} running {} with {} listen addrs",
                    peer_id,
                    info.protocol_version,
                    info.listen_addrs.len()
                );
                // Add identified addresses to Kademlia
                for addr in &info.listen_addrs {
                    self.swarm
                        .behaviour_mut()
                        .kademlia
                        .add_address(&peer_id, addr.clone());
                }

                // Extract tier from agent_version: "bitterbot-orchestrator/{version}/{tier}"
                let parts: Vec<&str> = info.agent_version.split('/').collect();
                let claimed_tier = parts.get(2).unwrap_or(&"edge").to_string();
                let mut tier_verified = false;
                let mut pubkey_b64 = String::new();

                if claimed_tier == "management" {
                    // Extract pubkey from identify's public key and check against trust list
                    if let Some(libp2p_pk) = info.public_key.clone().try_into_ed25519().ok() {
                        pubkey_b64 = base64::engine::general_purpose::STANDARD
                            .encode(libp2p_pk.to_bytes());
                        tier_verified = self.genesis_trust_list.contains(&pubkey_b64);
                    }
                }

                // Update PeerDetail with tier info
                {
                    let mut stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(detail) = stats.peer_details.get_mut(&peer_id.to_string()) {
                        detail.tier = claimed_tier.clone();
                        detail.tier_verified = tier_verified;
                    }
                }

                // Emit peer_identified IPC event
                self.emit_ipc_event(serde_json::json!({
                    "type": "peer_identified",
                    "payload": {
                        "peer_id": peer_id.to_string(),
                        "tier": claimed_tier,
                        "verified": tier_verified,
                        "pubkey": pubkey_b64,
                    }
                }));
            }
            BitterbotBehaviourEvent::Autonat(event) => {
                info!("AutoNAT event: {:?}", event);
                // When AutoNAT detects we're behind NAT, initiate relay reservations
                if self.relay_mode == RelayMode::Client {
                    if !self.has_relay_reservation && !self.relay_server_addrs.is_empty() {
                        info!("NAT detected, initiating relay reservations");
                        self.initiate_relay_reservations();
                    }
                }
            }
            BitterbotBehaviourEvent::RelayClient(event) => {
                match event {
                    relay::client::Event::ReservationReqAccepted { relay_peer_id, renewal, .. } => {
                        info!("Relay reservation accepted by {} (renewal: {})", relay_peer_id, renewal);
                        self.has_relay_reservation = true;

                        // Advertise relay address so other peers can reach us
                        let relay_addr: Multiaddr = format!(
                            "/p2p/{}/p2p-circuit",
                            relay_peer_id
                        ).parse().unwrap();
                        self.swarm.add_external_address(relay_addr);

                        self.emit_ipc_event(serde_json::json!({
                            "type": "relay_reservation_accepted",
                            "payload": {
                                "relay_peer_id": relay_peer_id.to_string(),
                                "renewal": renewal,
                            }
                        }));
                    }
                    // Note: libp2p-relay 0.18 does not have a ReservationReqFailed variant.
                    // Reservation failures surface as transport errors or connection failures.
                    relay::client::Event::OutboundCircuitEstablished { relay_peer_id, .. } => {
                        info!("Outbound circuit via relay {} established", relay_peer_id);
                        self.emit_ipc_event(serde_json::json!({
                            "type": "relay_circuit_established",
                            "payload": {
                                "relay_peer_id": relay_peer_id.to_string(),
                                "direction": "outbound",
                            }
                        }));
                    }
                    relay::client::Event::InboundCircuitEstablished { src_peer_id, .. } => {
                        info!("Inbound circuit from {} established", src_peer_id);
                        self.emit_ipc_event(serde_json::json!({
                            "type": "relay_circuit_established",
                            "payload": {
                                "src_peer_id": src_peer_id.to_string(),
                                "direction": "inbound",
                            }
                        }));
                    }
                }
            }
            BitterbotBehaviourEvent::RelayServer(event) => {
                match event {
                    relay::Event::ReservationReqAccepted { src_peer_id, renewed } => {
                        info!("Relay server: accepted reservation from {} (renewed: {})", src_peer_id, renewed);
                        self.emit_ipc_event(serde_json::json!({
                            "type": "relay_server_reservation",
                            "payload": {
                                "peer_id": src_peer_id.to_string(),
                                "renewed": renewed,
                            }
                        }));
                    }
                    relay::Event::ReservationTimedOut { src_peer_id } => {
                        debug!("Relay server: reservation timed out for {}", src_peer_id);
                    }
                    relay::Event::CircuitReqDenied { src_peer_id, dst_peer_id } => {
                        debug!("Relay server: circuit denied from {} to {}", src_peer_id, dst_peer_id);
                    }
                    _ => {}
                }
            }
            BitterbotBehaviourEvent::Dcutr(dcutr::Event { remote_peer_id, result }) => {
                match result {
                    Ok(_) => {
                        info!("DCUtR hole-punch succeeded with {}", remote_peer_id);
                        self.emit_ipc_event(serde_json::json!({
                            "type": "hole_punch_succeeded",
                            "payload": {
                                "peer_id": remote_peer_id.to_string(),
                            }
                        }));
                    }
                    Err(ref e) => {
                        warn!("DCUtR hole-punch failed with {}: {:?}", remote_peer_id, e);
                        self.emit_ipc_event(serde_json::json!({
                            "type": "hole_punch_failed",
                            "payload": {
                                "peer_id": remote_peer_id.to_string(),
                                "error": format!("{:?}", e),
                            }
                        }));
                    }
                }
            }
            _ => {}
        }
    }

    fn initiate_relay_reservations(&mut self) {
        if self.has_relay_reservation {
            debug!("Already have relay reservation, skipping");
            return;
        }
        for (addr, peer_id) in self.relay_server_addrs.clone() {
            info!("Requesting relay reservation from {} at {}", peer_id, addr);
            let relay_addr = addr
                .with(libp2p::multiaddr::Protocol::P2p(peer_id))
                .with(libp2p::multiaddr::Protocol::P2pCircuit);
            match self.swarm.listen_on(relay_addr.clone()) {
                Ok(_) => info!("Listening on relay circuit: {}", relay_addr),
                Err(e) => warn!("Failed to listen on relay {}: {}", relay_addr, e),
            }
        }
    }

    async fn handle_ipc_command(&mut self, cmd: IpcCommand) {
        match cmd {
            IpcCommand::PublishSkill {
                id,
                payload,
                respond,
            } => {
                debug!("Publishing skill: {}", payload.name);
                let envelope = crypto::sign_skill(
                    &self.signing_key,
                    &self.local_peer_id,
                    &payload.skill_md,
                    &payload.name,
                );

                // Serialize and publish via Gossipsub
                match serde_json::to_vec(&envelope) {
                    Ok(serialized) => {
                        match self.swarm.behaviour_mut().gossipsub.publish(
                            self.skills_topic.clone(),
                            serialized,
                        ) {
                            Ok(msg_id) => {
                                let peers_reached = self
                                    .swarm
                                    .behaviour()
                                    .gossipsub
                                    .all_mesh_peers()
                                    .count();
                                let mut stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                                stats.skills_published += 1;
                                let _ = respond.send(serde_json::json!({
                                    "type": "response",
                                    "id": id,
                                    "payload": {
                                        "ok": true,
                                        "content_hash": envelope.content_hash,
                                        "peers_reached": peers_reached,
                                        "message_id": msg_id.to_string()
                                    }
                                }));
                                info!(
                                    "Skill published: {} (hash: {}, reached: {} peers)",
                                    payload.name, envelope.content_hash, peers_reached
                                );
                            }
                            Err(e) => {
                                warn!("Failed to publish skill to gossipsub: {}", e);
                                let _ = respond.send(serde_json::json!({
                                    "type": "response",
                                    "id": id,
                                    "payload": {
                                        "ok": false,
                                        "error": format!("gossipsub publish failed: {}", e),
                                        "content_hash": envelope.content_hash,
                                        "peers_reached": 0
                                    }
                                }));
                            }
                        }
                    }
                    Err(e) => {
                        error!("Failed to serialize envelope: {}", e);
                        let _ = respond.send(serde_json::json!({
                            "type": "response",
                            "id": id,
                            "payload": { "ok": false, "error": e.to_string() }
                        }));
                    }
                }
            }
            IpcCommand::GetPeers { id, respond } => {
                let stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                let _ = respond.send(serde_json::json!({
                    "type": "response",
                    "id": id,
                    "payload": {
                        "peers": stats.connected_peers,
                        "peer_details": stats.peer_details
                    }
                }));
            }
            IpcCommand::GetStats { id, respond } => {
                let stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                let _ = respond.send(serde_json::json!({
                    "type": "response",
                    "id": id,
                    "payload": {
                        "peer_id": stats.peer_id,
                        "peers": stats.connected_peers,
                        "published": stats.skills_published,
                        "received": stats.skills_received,
                        "uptime_secs": stats.uptime_secs,
                        "mesh_peers_count": stats.mesh_peers_count,
                        "subscribed_topics": stats.subscribed_topics,
                        "listen_addrs": stats.listen_addrs
                    }
                }));
            }
            IpcCommand::GetIdentity { id, respond } => {
                // Expose the orchestrator's Ed25519 libp2p pubkey (base64) so the
                // TypeScript layer can use it as the management-node identity and
                // verify it against the genesis trust list. Peer ID is the libp2p
                // multihash form; node_tier reflects startup config.
                let pubkey_b64 = base64::engine::general_purpose::STANDARD
                    .encode(self.signing_key.verifying_key().to_bytes());
                let _ = respond.send(serde_json::json!({
                    "type": "response",
                    "id": id,
                    "payload": {
                        "pubkey": pubkey_b64,
                        "peer_id": self.local_peer_id.to_string(),
                        "node_tier": self.node_tier,
                    }
                }));
            }
            IpcCommand::ComputeEigenTrust {
                id,
                payload,
                respond,
            } => {
                debug!(
                    "Computing EigenTrust: {} edges, {} pre-trusted, max {} iterations",
                    payload.trust_edges.len(),
                    payload.pre_trusted.len(),
                    payload.max_iterations,
                );
                let scores = compute_eigentrust(
                    &payload.trust_edges,
                    &payload.pre_trusted,
                    payload.max_iterations,
                );

                // Inject EigenTrust scores into gossipsub peer scoring
                // Map peer pubkeys/IDs to PeerIds and set application-specific scores
                {
                    let stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                    let mut injected = 0usize;
                    for (peer_key, &score) in &scores {
                        // Try to find the PeerId for this pubkey by checking peer_details
                        for (peer_id_str, detail) in &stats.peer_details {
                            // Match by peer_id string or pubkey
                            if peer_id_str == peer_key || detail.tier == *peer_key {
                                if let Ok(peer_id) = peer_id_str.parse::<PeerId>() {
                                    // Map EigenTrust score (0-1) to gossipsub app score (-100 to 100)
                                    let app_score = (score - 0.5) * 200.0;
                                    self.swarm.behaviour_mut().gossipsub
                                        .set_application_score(&peer_id, app_score);
                                    injected += 1;
                                }
                                break;
                            }
                        }
                    }
                    if injected > 0 {
                        info!("Injected {} EigenTrust scores into gossipsub peer scoring", injected);
                    }
                }

                let _ = respond.send(serde_json::json!({
                    "type": "response",
                    "id": id,
                    "payload": {
                        "scores": scores
                    }
                }));
            }
            IpcCommand::SignAsManagement { id, payload, respond } => {
                if self.node_tier != "management" {
                    let _ = respond.send(serde_json::json!({
                        "type": "response", "id": id,
                        "payload": { "ok": false, "error": "not a management node" }
                    }));
                    return;
                }
                let (sig, pubkey) = crypto::sign_as_management(&self.signing_key, &payload.skill_md);
                let _ = respond.send(serde_json::json!({
                    "type": "response", "id": id,
                    "payload": { "ok": true, "management_signature": sig, "management_pubkey": pubkey }
                }));
            }
            IpcCommand::PublishWeather { id, payload, respond } => {
                if self.node_tier != "management" {
                    let _ = respond.send(serde_json::json!({
                        "type": "response", "id": id,
                        "payload": { "ok": false, "error": "not a management node" }
                    }));
                    return;
                }
                let (sig, pubkey) = crypto::sign_weather(
                    &self.signing_key,
                    payload.global_cortisol_spike,
                    payload.duration_ms,
                    &payload.reason,
                );
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
                let envelope = WeatherEnvelope {
                    global_cortisol_spike: payload.global_cortisol_spike,
                    duration_ms: payload.duration_ms,
                    reason: payload.reason,
                    management_pubkey: pubkey,
                    management_signature: sig,
                    timestamp: now_ms,
                };
                match serde_json::to_vec(&envelope) {
                    Ok(serialized) => {
                        match self.swarm.behaviour_mut().gossipsub.publish(
                            self.weather_topic.clone(), serialized,
                        ) {
                            Ok(_) => {
                                let _ = respond.send(serde_json::json!({
                                    "type": "response", "id": id,
                                    "payload": { "ok": true }
                                }));
                            }
                            Err(e) => {
                                let _ = respond.send(serde_json::json!({
                                    "type": "response", "id": id,
                                    "payload": { "ok": false, "error": format!("publish failed: {}", e) }
                                }));
                            }
                        }
                    }
                    Err(e) => {
                        let _ = respond.send(serde_json::json!({
                            "type": "response", "id": id,
                            "payload": { "ok": false, "error": format!("serialize failed: {}", e) }
                        }));
                    }
                }
            }
            IpcCommand::PublishBounty { id, payload, respond } => {
                if self.node_tier != "management" {
                    let _ = respond.send(serde_json::json!({
                        "type": "response", "id": id,
                        "payload": { "ok": false, "error": "not a management node" }
                    }));
                    return;
                }
                let (sig, pubkey) = crypto::sign_bounty(
                    &self.signing_key,
                    &payload.bounty_id, &payload.target_type, &payload.description,
                    payload.priority, payload.reward_multiplier, payload.expires_at,
                );
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
                let envelope = BountyEnvelope {
                    bounty_id: payload.bounty_id,
                    target_type: payload.target_type,
                    description: payload.description,
                    priority: payload.priority,
                    reward_multiplier: payload.reward_multiplier,
                    region_hint: payload.region_hint,
                    expires_at: payload.expires_at,
                    management_pubkey: pubkey,
                    management_signature: sig,
                    timestamp: now_ms,
                };
                match serde_json::to_vec(&envelope) {
                    Ok(serialized) => {
                        match self.swarm.behaviour_mut().gossipsub.publish(
                            self.bounties_topic.clone(), serialized,
                        ) {
                            Ok(_) => {
                                let _ = respond.send(serde_json::json!({
                                    "type": "response", "id": id,
                                    "payload": { "ok": true }
                                }));
                            }
                            Err(e) => {
                                let _ = respond.send(serde_json::json!({
                                    "type": "response", "id": id,
                                    "payload": { "ok": false, "error": format!("publish failed: {}", e) }
                                }));
                            }
                        }
                    }
                    Err(e) => {
                        let _ = respond.send(serde_json::json!({
                            "type": "response", "id": id,
                            "payload": { "ok": false, "error": format!("serialize failed: {}", e) }
                        }));
                    }
                }
            }
            IpcCommand::PublishTelemetry { id, payload, respond } => {
                let (sig, pubkey) = crypto::sign_telemetry(
                    &self.signing_key,
                    &payload.signal_type,
                    &payload.data,
                );
                let now_secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
                let envelope = TelemetryEnvelope {
                    signal_type: payload.signal_type,
                    data: payload.data,
                    author_peer_id: self.local_peer_id.to_string(),
                    author_pubkey: pubkey,
                    signature: sig,
                    timestamp: now_secs,
                };
                match serde_json::to_vec(&envelope) {
                    Ok(serialized) => {
                        match self.swarm.behaviour_mut().gossipsub.publish(
                            self.telemetry_topic.clone(), serialized,
                        ) {
                            Ok(_) => {
                                let _ = respond.send(serde_json::json!({
                                    "type": "response", "id": id,
                                    "payload": { "ok": true }
                                }));
                                debug!("Telemetry published: type={}", envelope.signal_type);
                            }
                            Err(e) => {
                                let _ = respond.send(serde_json::json!({
                                    "type": "response", "id": id,
                                    "payload": { "ok": false, "error": format!("publish failed: {}", e) }
                                }));
                            }
                        }
                    }
                    Err(e) => {
                        let _ = respond.send(serde_json::json!({
                            "type": "response", "id": id,
                            "payload": { "ok": false, "error": format!("serialize failed: {}", e) }
                        }));
                    }
                }
            }
            IpcCommand::PublishQuery { id, payload, respond } => {
                let (sig, pubkey) = crypto::sign_query(
                    &self.signing_key,
                    &payload.query_id,
                    &payload.query,
                );
                let now_secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
                let envelope = QueryEnvelope {
                    query_id: payload.query_id,
                    query: payload.query,
                    domain_hint: payload.domain_hint,
                    author_peer_id: self.local_peer_id.to_string(),
                    author_pubkey: pubkey,
                    signature: sig,
                    timestamp: now_secs,
                };
                match serde_json::to_vec(&envelope) {
                    Ok(serialized) => {
                        match self.swarm.behaviour_mut().gossipsub.publish(
                            self.queries_topic.clone(), serialized,
                        ) {
                            Ok(_) => {
                                let _ = respond.send(serde_json::json!({
                                    "type": "response", "id": id,
                                    "payload": { "ok": true }
                                }));
                                debug!("Query published: id={}", envelope.query_id);
                            }
                            Err(e) => {
                                let _ = respond.send(serde_json::json!({
                                    "type": "response", "id": id,
                                    "payload": { "ok": false, "error": format!("publish failed: {}", e) }
                                }));
                            }
                        }
                    }
                    Err(e) => {
                        let _ = respond.send(serde_json::json!({
                            "type": "response", "id": id,
                            "payload": { "ok": false, "error": format!("serialize failed: {}", e) }
                        }));
                    }
                }
            }
            IpcCommand::GetNetworkCensus { id, respond } => {
                if self.node_tier != "management" {
                    let _ = respond.send(serde_json::json!({
                        "type": "response", "id": id,
                        "payload": { "ok": false, "error": "not a management node" }
                    }));
                    return;
                }
                let census = if let Some(ref mgmt) = self.management_state {
                    let state = mgmt.lock().unwrap_or_else(|e| e.into_inner());
                    let stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                    serde_json::json!({
                        "ok": true,
                        "total_peers_seen": state.total_peers_seen,
                        "peers_by_tier": state.peers_by_tier,
                        "skills_published_network_wide": state.skills_published_network_wide,
                        "telemetry_counts_by_type": state.telemetry_counts_by_type,
                        "network_health_score": state.network_health_score,
                        "last_census_at": state.last_census_at,
                        "connected_peers": stats.connected_peers,
                        "peer_count_history": state.peer_count_history.iter()
                            .rev().take(100).collect::<Vec<_>>(),
                    })
                } else {
                    serde_json::json!({ "ok": false, "error": "management state not initialized" })
                };
                let _ = respond.send(serde_json::json!({
                    "type": "response", "id": id, "payload": census
                }));
            }
            IpcCommand::GetAnomalyAlerts { id, respond } => {
                if self.node_tier != "management" {
                    let _ = respond.send(serde_json::json!({
                        "type": "response", "id": id,
                        "payload": { "ok": false, "error": "not a management node" }
                    }));
                    return;
                }
                let alerts = if let Some(ref mgmt) = self.management_state {
                    let state = mgmt.lock().unwrap_or_else(|e| e.into_inner());
                    serde_json::json!({
                        "ok": true,
                        "alerts": state.anomaly_alerts,
                        "network_health_score": state.network_health_score,
                    })
                } else {
                    serde_json::json!({ "ok": false, "error": "management state not initialized" })
                };
                let _ = respond.send(serde_json::json!({
                    "type": "response", "id": id, "payload": alerts
                }));
            }
            IpcCommand::PropagateBan { id, peer_pubkey, reason, respond } => {
                if self.node_tier != "management" {
                    let _ = respond.send(serde_json::json!({
                        "type": "response", "id": id,
                        "payload": { "ok": false, "error": "not a management node" }
                    }));
                    return;
                }
                // Publish ban via telemetry topic — signed with management key
                let ban_data = serde_json::json!({ "peer_pubkey": peer_pubkey, "reason": reason });
                let (signature, author_pubkey) = crypto::sign_telemetry(
                    &self.signing_key,
                    "management_ban",
                    &ban_data,
                );
                let ban_envelope = serde_json::json!({
                    "signal_type": "management_ban",
                    "data": ban_data,
                    "author_peer_id": self.local_peer_id.to_string(),
                    "author_pubkey": author_pubkey,
                    "signature": signature,
                    "timestamp": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                });
                match serde_json::to_vec(&ban_envelope) {
                    Ok(data) => {
                        match self.swarm.behaviour_mut().gossipsub.publish(
                            self.telemetry_topic.clone(), data
                        ) {
                            Ok(_) => {
                                info!("Ban propagated for peer {} (reason: {})", peer_pubkey, reason);
                                let _ = respond.send(serde_json::json!({
                                    "type": "response", "id": id,
                                    "payload": { "ok": true }
                                }));
                            }
                            Err(e) => {
                                let _ = respond.send(serde_json::json!({
                                    "type": "response", "id": id,
                                    "payload": { "ok": false, "error": format!("publish failed: {}", e) }
                                }));
                            }
                        }
                    }
                    Err(e) => {
                        let _ = respond.send(serde_json::json!({
                            "type": "response", "id": id,
                            "payload": { "ok": false, "error": format!("serialize failed: {}", e) }
                        }));
                    }
                }
            }
        }
    }

    async fn handle_swarm_event(&mut self, event: SwarmEvent) {
        match event {
            SwarmEvent::SkillReceived(mut envelope) => {
                if !self.security.validate_envelope(&envelope) {
                    warn!(
                        "Rejected invalid skill envelope from {}",
                        envelope.author_peer_id
                    );
                    return;
                }

                // Validate management signature (strips invalid claims but never rejects)
                self.security.validate_management_signature(&mut envelope);

                // Update per-peer skills_received_from counter
                {
                    let mut stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                    stats.skills_received += 1;
                    if let Some(detail) = stats.peer_details.get_mut(&envelope.author_peer_id) {
                        detail.skills_received_from += 1;
                        // Diminishing reputation gain: logarithmic scaling, capped at 100
                        if detail.reputation_score < 100.0 {
                            let gain = 1.0 / (1.0 + (detail.skills_received_from as f64).ln());
                            detail.reputation_score = (detail.reputation_score + gain).min(100.0);
                        }
                    }
                }

                // Emit to IPC so Node.js can process the received skill
                self.emit_ipc_event(serde_json::json!({
                    "type": "skill_received",
                    "payload": envelope
                }));

                // Management node: track skill publication rate
                self.track_skill_publication(&envelope.author_peer_id);

                info!(
                    "Skill received: {} from {}",
                    envelope.name, envelope.author_peer_id
                );
            }
            SwarmEvent::WeatherReceived(envelope) => {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
                if envelope.timestamp + 300_000 < now_ms || envelope.timestamp > now_ms + 60_000 {
                    debug!("Dropping stale/future weather envelope (ts={})", envelope.timestamp);
                    return;
                }
                if !self.security.is_management_pubkey(&envelope.management_pubkey) {
                    warn!("Weather envelope from non-management pubkey, discarding");
                    return;
                }
                if !crypto::verify_weather(&envelope) {
                    warn!("Weather envelope has invalid signature, discarding");
                    return;
                }
                self.emit_ipc_event(serde_json::json!({
                    "type": "weather_received",
                    "payload": {
                        "global_cortisol_spike": envelope.global_cortisol_spike,
                        "duration_ms": envelope.duration_ms,
                        "reason": envelope.reason,
                        "management_pubkey": envelope.management_pubkey,
                        "timestamp": envelope.timestamp,
                    }
                }));
                info!("Weather broadcast received: cortisol={} reason={}", envelope.global_cortisol_spike, envelope.reason);
            }
            SwarmEvent::BountyReceived(envelope) => {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
                if envelope.timestamp + 300_000 < now_ms || envelope.timestamp > now_ms + 60_000 {
                    debug!("Dropping stale/future bounty envelope (ts={})", envelope.timestamp);
                    return;
                }
                if !self.security.is_management_pubkey(&envelope.management_pubkey) {
                    warn!("Bounty envelope from non-management pubkey, discarding");
                    return;
                }
                if !crypto::verify_bounty(&envelope) {
                    warn!("Bounty envelope has invalid signature, discarding");
                    return;
                }
                self.emit_ipc_event(serde_json::json!({
                    "type": "bounty_received",
                    "payload": {
                        "bounty_id": envelope.bounty_id,
                        "target_type": envelope.target_type,
                        "description": envelope.description,
                        "priority": envelope.priority,
                        "reward_multiplier": envelope.reward_multiplier,
                        "region_hint": envelope.region_hint,
                        "expires_at": envelope.expires_at,
                        "management_pubkey": envelope.management_pubkey,
                        "timestamp": envelope.timestamp,
                    }
                }));
                info!("Bounty received: {} (type: {})", envelope.bounty_id, envelope.target_type);
            }
            SwarmEvent::TelemetryReceived(envelope) => {
                // Timestamp window check
                if !self.security.validate_timestamp_secs(envelope.timestamp) {
                    debug!("Dropping stale/future telemetry (ts={})", envelope.timestamp);
                    return;
                }
                // Signature verification
                if !crypto::verify_telemetry(&envelope) {
                    warn!("Telemetry from {} has invalid signature, discarding", envelope.author_peer_id);
                    return;
                }
                // Per-peer rate limiting
                if !self.security.check_telemetry_rate(&envelope.author_peer_id) {
                    debug!("Telemetry rate limit exceeded for {}", envelope.author_peer_id);
                    return;
                }
                // Don't forward our own telemetry back to ourselves
                if envelope.author_peer_id == self.local_peer_id.to_string() {
                    return;
                }
                self.emit_ipc_event(serde_json::json!({
                    "type": "telemetry_received",
                    "payload": {
                        "signal_type": envelope.signal_type,
                        "data": envelope.data,
                        "author_peer_id": envelope.author_peer_id,
                        "timestamp": envelope.timestamp,
                    }
                }));
                // Management node: aggregate telemetry
                self.aggregate_telemetry(&envelope);

                debug!("Telemetry received: type={} from {}", envelope.signal_type, envelope.author_peer_id);
            }
            SwarmEvent::QueryReceived(envelope) => {
                // Timestamp window check
                if !self.security.validate_timestamp_secs(envelope.timestamp) {
                    debug!("Dropping stale/future query (ts={})", envelope.timestamp);
                    return;
                }
                // Signature verification
                if !crypto::verify_query(&envelope) {
                    warn!("Query from {} has invalid signature, discarding", envelope.author_peer_id);
                    return;
                }
                // Per-peer rate limiting
                if !self.security.check_query_rate(&envelope.author_peer_id) {
                    debug!("Query rate limit exceeded for {}", envelope.author_peer_id);
                    return;
                }
                // Don't forward our own queries back to ourselves
                if envelope.author_peer_id == self.local_peer_id.to_string() {
                    return;
                }
                self.emit_ipc_event(serde_json::json!({
                    "type": "query_received",
                    "payload": {
                        "query_id": envelope.query_id,
                        "query": envelope.query,
                        "domain_hint": envelope.domain_hint,
                        "author_peer_id": envelope.author_peer_id,
                        "timestamp": envelope.timestamp,
                    }
                }));
                info!("Query received: '{}' from {}", envelope.query, envelope.author_peer_id);
            }
            SwarmEvent::PeerConnected(peer_id, addrs) => {
                let addr_strings: Vec<String> = addrs.iter().map(|a| a.to_string()).collect();
                {
                    let mut stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                    stats.connected_peers += 1;
                    let detail = PeerDetail {
                        addrs: addr_strings.clone(),
                        connected_at: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                        skills_received_from: 0,
                        reputation_score: 0.0,
                        tier: String::new(),
                        tier_verified: false,
                    };
                    stats
                        .peer_details
                        .insert(peer_id.to_string(), detail);
                }

                // Emit to IPC
                self.emit_ipc_event(serde_json::json!({
                    "type": "peer_connected",
                    "payload": {
                        "peer_id": peer_id.to_string(),
                        "addrs": addr_strings
                    }
                }));

                info!("Peer connected: {} ({:?})", peer_id, addrs);
            }
            SwarmEvent::PeerDisconnected(peer_id) => {
                {
                    let mut stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
                    stats.connected_peers = stats.connected_peers.saturating_sub(1);
                    // Clear connection addrs but preserve reputation data
                    if let Some(detail) = stats.peer_details.get_mut(&peer_id.to_string()) {
                        detail.addrs.clear();
                        detail.connected_at = 0; // mark as disconnected
                    }
                }

                // Emit to IPC
                self.emit_ipc_event(serde_json::json!({
                    "type": "peer_disconnected",
                    "payload": {
                        "peer_id": peer_id.to_string()
                    }
                }));

                info!("Peer disconnected: {}", peer_id);
            }
        }
    }
}

/// Compute EigenTrust scores from a trust edge list via power iteration.
///
/// Algorithm: t_new = alpha * C^T * t + (1 - alpha) * p
/// where C is the row-normalized trust matrix and p is the pre-trust vector.
pub fn compute_eigentrust(
    edges: &[(String, String, f64)],
    pre_trusted: &[String],
    max_iterations: u32,
) -> HashMap<String, f64> {
    // Collect all peers
    let mut peer_set = std::collections::HashSet::new();
    for (a, b, _) in edges {
        peer_set.insert(a.clone());
        peer_set.insert(b.clone());
    }
    let peers: Vec<String> = peer_set.into_iter().collect();
    let n = peers.len();
    if n == 0 {
        return HashMap::new();
    }

    let idx: HashMap<&str, usize> = peers.iter().enumerate().map(|(i, p)| (p.as_str(), i)).collect();

    // Build row-normalized trust matrix C
    let mut c = vec![vec![0.0f64; n]; n];
    let mut row_sums = vec![0.0f64; n];

    for (truster, trustee, weight) in edges {
        if let (Some(&i), Some(&j)) = (idx.get(truster.as_str()), idx.get(trustee.as_str())) {
            let w = weight.max(0.0);
            c[i][j] += w;
            row_sums[i] += w;
        }
    }

    // Row-normalize
    for i in 0..n {
        if row_sums[i] > 0.0 {
            for j in 0..n {
                c[i][j] /= row_sums[i];
            }
        }
    }

    // Pre-trust vector p
    let mut p = vec![1.0 / n as f64; n];
    if !pre_trusted.is_empty() {
        p = vec![0.0; n];
        for pk in pre_trusted {
            if let Some(&i) = idx.get(pk.as_str()) {
                p[i] = 1.0 / pre_trusted.len() as f64;
            }
        }
    }

    // Power iteration
    let alpha = 0.9;
    let convergence_threshold = 0.001;
    let mut t = vec![1.0 / n as f64; n];

    for _ in 0..max_iterations {
        let mut t_new = vec![0.0f64; n];

        // C^T * t
        for i in 0..n {
            for j in 0..n {
                t_new[j] += c[i][j] * t[i];
            }
        }

        // Blend: alpha * C^T*t + (1-alpha) * p
        for i in 0..n {
            t_new[i] = alpha * t_new[i] + (1.0 - alpha) * p[i];
        }

        // Check convergence
        let max_diff = t.iter().zip(t_new.iter()).map(|(a, b)| (a - b).abs()).fold(0.0f64, f64::max);

        t = t_new;
        if max_diff < convergence_threshold {
            break;
        }
    }

    peers.into_iter().enumerate().map(|(i, p)| (p, t[i])).collect()
}

/// Convert an `ed25519_dalek::SigningKey` into a `libp2p::identity::Keypair`.
fn dalek_to_libp2p_keypair(signing_key: &SigningKey) -> libp2p::identity::Keypair {
    let secret_bytes = signing_key.to_bytes();
    let public_bytes = signing_key.verifying_key().to_bytes();
    let mut combined = [0u8; 64];
    combined[..32].copy_from_slice(&secret_bytes);
    combined[32..].copy_from_slice(&public_bytes);
    let libp2p_kp = libp2p::identity::ed25519::Keypair::try_from_bytes(&mut combined)
        .expect("valid ed25519 keypair bytes");
    libp2p::identity::Keypair::from(libp2p_kp)
}

/// Parse relay server multiaddresses into (addr_without_p2p, peer_id) pairs.
fn parse_relay_servers(relay_servers: &[String]) -> Vec<(Multiaddr, PeerId)> {
    let mut result = Vec::new();
    for s in relay_servers {
        match s.parse::<Multiaddr>() {
            Ok(addr) => {
                if let Some(libp2p::multiaddr::Protocol::P2p(peer_id)) =
                    addr.iter().find(|p| matches!(p, libp2p::multiaddr::Protocol::P2p(_)))
                {
                    let addr_without_p2p: Multiaddr = addr
                        .iter()
                        .filter(|p| !matches!(p, libp2p::multiaddr::Protocol::P2p(_)))
                        .collect();
                    result.push((addr_without_p2p, peer_id));
                } else {
                    warn!("Relay server address {} missing /p2p/<peer_id>, skipping", s);
                }
            }
            Err(e) => warn!("Invalid relay server address '{}': {}", s, e),
        }
    }
    result
}

pub async fn build_swarm(
    keypair: &SigningKey,
    listen_addr: &str,
    bootstrap_peers: &[String],
    node_tier: &str,
    genesis_trust_list: Vec<String>,
    relay_mode: RelayMode,
    relay_servers: &[String],
) -> Result<
    (
        SwarmHandle,
        mpsc::UnboundedReceiver<serde_json::Value>,
    ),
    Box<dyn std::error::Error>,
> {
    let local_peer_id = crypto::peer_id_from_keypair(keypair);
    let libp2p_keypair = dalek_to_libp2p_keypair(keypair);

    // --- Gossipsub configuration ---
    let gossipsub_config = gossipsub::ConfigBuilder::default()
        .heartbeat_interval(Duration::from_secs(1))
        .validation_mode(ValidationMode::Strict)
        .max_transmit_size(MAX_GOSSIPSUB_MSG_SIZE)
        .build()
        .map_err(|e| format!("gossipsub config error: {}", e))?;

    let mut gossipsub_behaviour = gossipsub::Behaviour::new(
        MessageAuthenticity::Signed(libp2p_keypair.clone()),
        gossipsub_config,
    )
    .map_err(|e| format!("gossipsub behaviour error: {}", e))?;

    // Enable peer scoring — integrates with EigenTrust reputation
    {
        use gossipsub::{PeerScoreParams, PeerScoreThresholds, TopicScoreParams};
        let mut topic_params = HashMap::new();

        // Skills topic: reward valid skills, penalize invalid
        let skills_score = TopicScoreParams {
            topic_weight: 1.0,
            time_in_mesh_weight: 0.5,
            time_in_mesh_quantum: Duration::from_secs(1),
            time_in_mesh_cap: 3600.0,
            first_message_deliveries_weight: 1.0,
            first_message_deliveries_decay: 0.5,
            first_message_deliveries_cap: 50.0,
            mesh_message_deliveries_weight: -1.0,
            mesh_message_deliveries_decay: 0.5,
            mesh_message_deliveries_threshold: 1.0,
            mesh_message_deliveries_cap: 100.0,
            mesh_message_deliveries_activation: Duration::from_secs(30),
            mesh_message_deliveries_window: Duration::from_secs(5),
            mesh_failure_penalty_weight: -1.0,
            mesh_failure_penalty_decay: 0.5,
            invalid_message_deliveries_weight: -10.0,
            invalid_message_deliveries_decay: 0.3,
        };
        topic_params.insert(gossipsub::IdentTopic::new(SKILLS_TOPIC).hash(), skills_score);

        let score_params = PeerScoreParams {
            topics: topic_params,
            // Application-specific score: will be updated with EigenTrust values
            app_specific_weight: 5.0,
            // IP colocation penalty — anti-Sybil
            ip_colocation_factor_weight: -50.0,
            ip_colocation_factor_threshold: 3.0, // penalize >3 peers from same /24
            decay_interval: Duration::from_secs(60),
            decay_to_zero: 0.01,
            retain_score: Duration::from_secs(3600),
            ..Default::default()
        };

        let thresholds = PeerScoreThresholds {
            gossip_threshold: -100.0,
            publish_threshold: -200.0,
            graylist_threshold: -300.0,
            accept_px_threshold: 10.0,
            opportunistic_graft_threshold: 5.0,
        };

        gossipsub_behaviour
            .with_peer_score(score_params, thresholds)
            .map_err(|e| format!("gossipsub peer score error: {}", e))?;

        info!("Gossipsub peer scoring enabled (IP colocation + app-specific EigenTrust)");
    }

    // Subscribe to topics
    let skills_topic = gossipsub::IdentTopic::new(SKILLS_TOPIC);
    let telemetry_topic = gossipsub::IdentTopic::new(TELEMETRY_TOPIC);
    let weather_topic = gossipsub::IdentTopic::new(WEATHER_TOPIC);
    let bounties_topic = gossipsub::IdentTopic::new(BOUNTIES_TOPIC);
    let queries_topic = gossipsub::IdentTopic::new(QUERIES_TOPIC);
    gossipsub_behaviour.subscribe(&skills_topic)?;
    gossipsub_behaviour.subscribe(&telemetry_topic)?;
    gossipsub_behaviour.subscribe(&weather_topic)?;
    gossipsub_behaviour.subscribe(&bounties_topic)?;
    gossipsub_behaviour.subscribe(&queries_topic)?;
    info!("Subscribed to topics: {}, {}, {}, {}, {}", SKILLS_TOPIC, TELEMETRY_TOPIC, WEATHER_TOPIC, BOUNTIES_TOPIC, QUERIES_TOPIC);

    // --- Kademlia configuration ---
    let kademlia_store = MemoryStore::new(local_peer_id);
    let kademlia_protocol = libp2p::StreamProtocol::new("/bitterbot/kad/1.0.0");
    let mut kademlia_config = kad::Config::new(kademlia_protocol);
    kademlia_config.set_query_timeout(Duration::from_secs(60));
    let mut kademlia_behaviour =
        kad::Behaviour::with_config(local_peer_id, kademlia_store, kademlia_config);
    kademlia_behaviour.set_mode(Some(kad::Mode::Server));

    // Add bootstrap peers to Kademlia
    for peer_str in bootstrap_peers {
        match peer_str.parse::<Multiaddr>() {
            Ok(addr) => {
                // Extract peer ID from the multiaddr if it contains /p2p/<peer_id>
                if let Some(libp2p::multiaddr::Protocol::P2p(peer_id)) =
                    addr.iter().find(|p| matches!(p, libp2p::multiaddr::Protocol::P2p(_)))
                {
                    let addr_without_p2p: Multiaddr = addr
                        .iter()
                        .filter(|p| !matches!(p, libp2p::multiaddr::Protocol::P2p(_)))
                        .collect();
                    kademlia_behaviour.add_address(&peer_id, addr_without_p2p);
                    info!("Added bootstrap peer: {} at {}", peer_id, addr);
                } else {
                    warn!(
                        "Bootstrap address {} missing /p2p/<peer_id> component, skipping",
                        peer_str
                    );
                }
            }
            Err(e) => {
                warn!("Invalid bootstrap address '{}': {}", peer_str, e);
            }
        }
    }

    // --- AutoNAT v2 client configuration ---
    let autonat_behaviour = autonat::v2::client::Behaviour::new(
        rand::rngs::OsRng,
        autonat::v2::client::Config::default(),
    );

    // --- Identify configuration ---
    let identify_config = identify::Config::new(
        "/bitterbot/id/1.0.0".to_string(),
        libp2p_keypair.public(),
    )
    .with_agent_version(format!("bitterbot-orchestrator/{}/{}", env!("CARGO_PKG_VERSION"), node_tier));

    let identify_behaviour = identify::Behaviour::new(identify_config);

    // --- Build swarm based on relay mode ---
    let idle_timeout = if relay_mode == RelayMode::Client {
        Duration::from_secs(120) // Longer timeout for relayed connections
    } else {
        Duration::from_secs(60)
    };

    let mut swarm = match relay_mode {
        RelayMode::Client => {
            info!("Building swarm with relay client + dcutr");
            SwarmBuilder::with_existing_identity(libp2p_keypair)
                .with_tokio()
                .with_tcp(
                    tcp::Config::default().nodelay(true),
                    noise::Config::new,
                    yamux::Config::default,
                )?
                .with_dns()?
                .with_relay_client(noise::Config::new, yamux::Config::default)?
                .with_behaviour(|key: &libp2p::identity::Keypair, relay_client_behaviour| {
                    Ok(BitterbotBehaviour {
                        gossipsub: gossipsub_behaviour,
                        kademlia: kademlia_behaviour,
                        autonat: autonat_behaviour,
                        identify: identify_behaviour,
                        relay_client: Toggle::from(Some(relay_client_behaviour)),
                        relay_server: Toggle::from(None),
                        dcutr: Toggle::from(Some(dcutr::Behaviour::new(key.public().to_peer_id()))),
                    })
                })?
                .with_swarm_config(|cfg: libp2p::swarm::Config| {
                    cfg.with_idle_connection_timeout(idle_timeout)
                })
                .build()
        }
        RelayMode::Server => {
            info!("Building swarm with relay server");
            let relay_server_config = relay::Config::default();
            SwarmBuilder::with_existing_identity(libp2p_keypair)
                .with_tokio()
                .with_tcp(
                    tcp::Config::default().nodelay(true),
                    noise::Config::new,
                    yamux::Config::default,
                )?
                .with_dns()?
                .with_behaviour(|_key| {
                    Ok(BitterbotBehaviour {
                        gossipsub: gossipsub_behaviour,
                        kademlia: kademlia_behaviour,
                        autonat: autonat_behaviour,
                        identify: identify_behaviour,
                        relay_client: Toggle::from(None),
                        relay_server: Toggle::from(Some(relay::Behaviour::new(
                            local_peer_id,
                            relay_server_config,
                        ))),
                        dcutr: Toggle::from(None),
                    })
                })?
                .with_swarm_config(|cfg: libp2p::swarm::Config| {
                    cfg.with_idle_connection_timeout(idle_timeout)
                })
                .build()
        }
        RelayMode::Off | RelayMode::Auto => {
            info!("Building swarm without relay");
            SwarmBuilder::with_existing_identity(libp2p_keypair)
                .with_tokio()
                .with_tcp(
                    tcp::Config::default().nodelay(true),
                    noise::Config::new,
                    yamux::Config::default,
                )?
                .with_dns()?
                .with_behaviour(|_key| {
                    Ok(BitterbotBehaviour {
                        gossipsub: gossipsub_behaviour,
                        kademlia: kademlia_behaviour,
                        autonat: autonat_behaviour,
                        identify: identify_behaviour,
                        relay_client: Toggle::from(None),
                        relay_server: Toggle::from(None),
                        dcutr: Toggle::from(None),
                    })
                })?
                .with_swarm_config(|cfg: libp2p::swarm::Config| {
                    cfg.with_idle_connection_timeout(idle_timeout)
                })
                .build()
        }
    };

    // Listen on the specified address
    let listen_multiaddr: Multiaddr = listen_addr.parse()?;
    swarm.listen_on(listen_multiaddr)?;

    // Trigger initial Kademlia bootstrap if we have bootstrap peers
    if !bootstrap_peers.is_empty() {
        if let Err(e) = swarm.behaviour_mut().kademlia.bootstrap() {
            warn!("Initial Kademlia bootstrap failed (no peers in routing table yet): {}", e);
        }
    }

    let (ipc_event_tx, ipc_event_rx) = mpsc::unbounded_channel();

    let stats = Arc::new(Mutex::new(SwarmStats {
        peer_id: local_peer_id.to_string(),
        connected_peers: 0,
        skills_published: 0,
        skills_received: 0,
        uptime_secs: 0,
        peer_details: HashMap::new(),
        listen_addrs: vec![listen_addr.to_string()],
        mesh_peers_count: 0,
        subscribed_topics: vec![SKILLS_TOPIC.to_string(), TELEMETRY_TOPIC.to_string(), WEATHER_TOPIC.to_string(), BOUNTIES_TOPIC.to_string(), QUERIES_TOPIC.to_string()],
    }));

    let management_state = if node_tier == "management" {
        info!("Management node: initializing aggregation state");
        Some(Arc::new(Mutex::new(ManagementState::new())))
    } else {
        None
    };

    // Parse relay server addresses for client mode
    let relay_server_addrs = if relay_mode == RelayMode::Client {
        let mut addrs = parse_relay_servers(relay_servers);
        // Also use bootstrap peers as relay servers if no explicit relay servers
        if addrs.is_empty() {
            info!("No explicit relay servers; using bootstrap peers as relay candidates");
            addrs = parse_relay_servers(bootstrap_peers);
        }
        if !addrs.is_empty() {
            info!("Relay servers configured: {} candidates", addrs.len());
        }
        addrs
    } else {
        vec![]
    };

    let handle = SwarmHandle {
        signing_key: keypair.clone(),
        local_peer_id,
        stats,
        security: SecurityValidator::new(genesis_trust_list.clone()),
        swarm,
        skills_topic,
        telemetry_topic,
        weather_topic,
        bounties_topic,
        queries_topic,
        ipc_event_tx,
        genesis_trust_list,
        node_tier: node_tier.to_string(),
        management_state,
        nat_status: NatStatus::Unknown,
        relay_server_addrs,
        has_relay_reservation: false,
        relay_mode,
    };

    info!(
        "Swarm initialized for peer {} on {}",
        local_peer_id, listen_addr
    );

    Ok((handle, ipc_event_rx))
}
