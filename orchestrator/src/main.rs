mod computer;
mod crypto;
mod ipc;
mod security;
mod swarm;

use base64::Engine as _;
use clap::Parser;
use std::path::PathBuf;
use tracing::info;
use tracing_subscriber::EnvFilter;

pub use swarm::RelayMode;

#[derive(Parser, Debug)]
#[command(name = "bitterbot-orchestrator")]
#[command(about = "P2P orchestrator daemon for Bitterbot skill propagation")]
struct Args {
    /// Path for the Unix domain socket IPC
    #[arg(long, default_value = "/tmp/bitterbot-orchestrator.sock")]
    ipc_path: PathBuf,

    /// Directory containing Ed25519 keypair
    #[arg(long, default_value = "./keys")]
    key_dir: PathBuf,

    /// libp2p listen address (port 9100 is the standard Bitterbot P2P port)
    #[arg(long, default_value = "/ip4/0.0.0.0/tcp/9100")]
    listen_addr: String,

    /// Bootstrap peer multiaddresses (e.g. /ip4/1.2.3.4/tcp/4001/p2p/12D3KooW...)
    /// Can be specified multiple times.
    #[arg(long)]
    bootstrap: Vec<String>,

    /// HTTP API listen address for dashboard
    #[arg(long, default_value = "127.0.0.1:9847")]
    http_addr: String,

    /// Bearer token for HTTP API authentication.
    /// Also reads from BITTERBOT_ORCHESTRATOR_AUTH_TOKEN env var.
    #[arg(long, env = "BITTERBOT_ORCHESTRATOR_AUTH_TOKEN")]
    http_auth_token: Option<String>,

    /// Node tier: "edge" (default) or "management".
    #[arg(long, default_value = "edge")]
    node_tier: String,

    /// Path to genesis trust list file (one base64 pubkey per line, # comments allowed).
    #[arg(long)]
    genesis_trust_list: Option<PathBuf>,

    /// HTTPS bootstrap registry URL for peer discovery.
    /// If set, fetches bootstrap peers from this URL on startup.
    /// Supports ?tier=edge or ?tier=management for tier-specific discovery.
    #[arg(long, env = "BITTERBOT_BOOTSTRAP_URL")]
    bootstrap_url: Option<String>,

    /// Relay mode: off (no relay), client (use relays for NAT traversal),
    /// server (serve as relay for NAT'd peers), auto (detect from node tier).
    #[arg(long, default_value = "auto", value_parser = parse_relay_mode)]
    relay_mode: RelayMode,

    /// Relay server multiaddresses to connect through when behind NAT.
    /// Only used in client/auto mode. Can be specified multiple times.
    /// Format: /ip4/1.2.3.4/tcp/9100/p2p/12D3KooW...
    #[arg(long)]
    relay_servers: Vec<String>,

    /// Bootnode mode: persist a lifetime registry of every distinct peer
    /// observed. Required for /api/bootstrap/census. Off by default; turn it
    /// on for the metro/Railway bootnode and other public bootstrap servers.
    #[arg(long, env = "BITTERBOT_BOOTNODE_MODE")]
    bootnode_mode: bool,

    /// Path to the bootnode registry snapshot file. Defaults to
    /// `<key_dir>/bootnode-peers.json`. Only used when --bootnode-mode is on.
    #[arg(long, env = "BITTERBOT_BOOTNODE_STATE")]
    bootnode_state: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let args = Args::parse();
    info!("Starting Bitterbot Orchestrator Daemon");
    info!("IPC path: {:?}", args.ipc_path);
    info!("Key dir: {:?}", args.key_dir);
    info!("Listen addr: {}", args.listen_addr);
    if !args.bootstrap.is_empty() {
        info!("Bootstrap peers: {:?}", args.bootstrap);
    } else {
        info!("No bootstrap peers configured (standalone mode)");
    }

    // Load or generate Ed25519 keypair
    let keypair = crypto::load_or_generate_keypair(&args.key_dir)?;
    let peer_id = crypto::peer_id_from_keypair(&keypair);
    info!("Local peer ID: {}", peer_id);

    // Parse genesis trust list
    let trust_list_path = args.genesis_trust_list.unwrap_or_else(|| args.key_dir.join("genesis_trust_list.txt"));
    let genesis_trust_list: Vec<String> = if trust_list_path.exists() {
        let content = std::fs::read_to_string(&trust_list_path)?;
        content
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(|l| l.to_string())
            .collect()
    } else {
        vec![]
    };
    info!("Genesis trust list: {} entries", genesis_trust_list.len());

    // If management tier, verify local pubkey is in the trust list
    if args.node_tier == "management" {
        let local_pubkey = base64::engine::general_purpose::STANDARD
            .encode(keypair.verifying_key().to_bytes());
        if !genesis_trust_list.contains(&local_pubkey) {
            eprintln!(
                "ERROR: This node is configured as management tier but its pubkey ({}) \
                 is not in the genesis trust list. Aborting.",
                local_pubkey
            );
            std::process::exit(1);
        }
        info!("Management node verified against genesis trust list");
    }
    info!("Node tier: {}", args.node_tier);

    // Fetch bootstrap peers from HTTPS registry if configured
    let mut bootstrap_peers = args.bootstrap.clone();
    if let Some(ref url) = args.bootstrap_url {
        info!("Fetching bootstrap peers from {}", url);
        let tier_url = format!("{}?tier={}", url, args.node_tier);
        match fetch_bootstrap_peers(&tier_url).await {
            Ok(peers) => {
                info!("Fetched {} bootstrap peers from registry", peers.len());
                bootstrap_peers.extend(peers);
            }
            Err(e) => {
                tracing::warn!("Bootstrap registry fetch failed: {} (using static peers)", e);
            }
        }
    }

    // Resolve relay mode: auto → server for management, client for edge
    let relay_mode = match args.relay_mode {
        RelayMode::Auto => {
            if args.node_tier == "management" {
                info!("Relay mode: auto → server (management tier)");
                RelayMode::Server
            } else {
                info!("Relay mode: auto → client (edge tier)");
                RelayMode::Client
            }
        }
        mode => {
            info!("Relay mode: {:?}", mode);
            mode
        }
    };

    // Resolve bootnode state path if bootnode mode is on. Default to
    // `<key_dir>/bootnode-peers.json` so it lands next to the keypair.
    let bootnode_state_path = if args.bootnode_mode {
        let path = args
            .bootnode_state
            .clone()
            .unwrap_or_else(|| args.key_dir.join("bootnode-peers.json"));
        info!("Bootnode mode enabled, registry: {:?}", path);
        Some(path)
    } else {
        None
    };

    // Build and start the libp2p swarm
    let (mut swarm_handle, ipc_event_rx) =
        swarm::build_swarm(
            &keypair,
            &args.listen_addr,
            &bootstrap_peers,
            &args.node_tier,
            genesis_trust_list,
            relay_mode,
            &args.relay_servers,
            bootnode_state_path,
        ).await?;

    // Start IPC listener — pass the swarm event channel so events are pushed
    // to connected IPC clients through the socket (not stdout).
    let (ipc_handle, ipc_cmd_rx) = ipc::start_ipc_listener(&args.ipc_path, ipc_event_rx).await?;

    // Start HTTP API for dashboard
    let stats = swarm_handle.stats();
    let bootnode_registry = swarm_handle.bootnode_registry();
    let http_addr = args.http_addr.clone();
    let http_auth_token = args.http_auth_token.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::swarm::http::serve_http(
            &http_addr,
            stats,
            http_auth_token,
            bootnode_registry,
        )
        .await
        {
            tracing::error!("HTTP API error: {}", e);
        }
    });

    // Main event loop: bridge IPC commands <-> swarm events
    info!("Orchestrator daemon running");
    swarm_handle.run_event_loop(ipc_cmd_rx).await?;

    // Cleanup
    drop(ipc_handle);
    let _ = tokio::fs::remove_file(&args.ipc_path).await;

    Ok(())
}

fn parse_relay_mode(s: &str) -> Result<RelayMode, String> {
    match s.to_lowercase().as_str() {
        "off" => Ok(RelayMode::Off),
        "client" => Ok(RelayMode::Client),
        "server" => Ok(RelayMode::Server),
        "auto" => Ok(RelayMode::Auto),
        _ => Err(format!(
            "invalid relay mode '{}': expected off|client|server|auto",
            s
        )),
    }
}

/// Fetch bootstrap peer multiaddresses from an HTTPS registry.
async fn fetch_bootstrap_peers(url: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(format!("Bootstrap registry returned {}", resp.status()).into());
    }
    let body: serde_json::Value = resp.json().await?;
    let peers = body
        .get("peers")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.get("multiaddr").and_then(|m| m.as_str()).map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(peers)
}
