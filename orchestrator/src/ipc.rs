use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixListener;
#[cfg(windows)]
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillPayload {
    pub skill_md: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EigenTrustPayload {
    pub trust_edges: Vec<(String, String, f64)>,
    pub pre_trusted: Vec<String>,
    pub max_iterations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherPayload {
    pub global_cortisol_spike: f64,
    pub duration_ms: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BountyPayload {
    pub bounty_id: String,
    pub target_type: String,
    pub description: String,
    pub priority: f64,
    pub reward_multiplier: f64,
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryPayload {
    pub signal_type: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryPayload {
    pub query_id: String,
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_hint: Option<String>,
}

#[derive(Debug)]
pub enum IpcCommand {
    PublishSkill {
        id: String,
        payload: SkillPayload,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetPeers {
        id: String,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetStats {
        id: String,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetIdentity {
        id: String,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ComputeEigenTrust {
        id: String,
        payload: EigenTrustPayload,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    SignAsManagement {
        id: String,
        payload: SkillPayload,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    PublishWeather {
        id: String,
        payload: WeatherPayload,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    PublishBounty {
        id: String,
        payload: BountyPayload,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    PublishTelemetry {
        id: String,
        payload: TelemetryPayload,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    PublishQuery {
        id: String,
        payload: QueryPayload,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    // Management node commands
    GetNetworkCensus {
        id: String,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    GetAnomalyAlerts {
        id: String,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    PropagateBan {
        id: String,
        peer_pubkey: String,
        reason: String,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    // PLAN-14 Pillar 4: OS-level computer use over IPC. The handlers in
    // src/computer.rs respect both the Cargo `computer-use` feature
    // (build-time) and BITTERBOT_COMPUTER_USE=1 (runtime).
    ComputerScreenshot {
        id: String,
        payload: crate::computer::ScreenshotArgs,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ComputerScreenSize {
        id: String,
        payload: crate::computer::ScreenshotArgs,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ComputerMouseMove {
        id: String,
        payload: crate::computer::MouseMoveArgs,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ComputerMouseClick {
        id: String,
        payload: crate::computer::MouseClickArgs,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ComputerType {
        id: String,
        payload: crate::computer::TypeArgs,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
    ComputerKey {
        id: String,
        payload: crate::computer::KeyArgs,
        respond: tokio::sync::oneshot::Sender<serde_json::Value>,
    },
}

#[derive(Debug, Deserialize)]
struct IpcMessage {
    #[serde(rename = "type")]
    msg_type: String,
    id: String,
    #[serde(default)]
    payload: serde_json::Value,
}

/// Start the IPC listener.
/// On Unix: Unix domain socket at `ipc_path`.
/// On Windows: Named pipe at `\\.\pipe\bitterbot-orchestrator`.
///
/// `event_rx` receives swarm events (skill_received, peer_connected, etc.)
/// from the main event loop and broadcasts them to all connected IPC clients.
pub async fn start_ipc_listener(
    ipc_path: &Path,
    event_rx: mpsc::UnboundedReceiver<serde_json::Value>,
) -> Result<(JoinHandle<()>, mpsc::UnboundedReceiver<IpcCommand>), Box<dyn std::error::Error>> {
    #[cfg(unix)]
    {
        // Remove stale socket file
        let _ = tokio::fs::remove_file(ipc_path).await;
    }

    #[cfg(unix)]
    let listener = UnixListener::bind(ipc_path)?;
    #[cfg(windows)]
    let listener = TcpListener::bind("127.0.0.1:19002").await?;
    // TODO: Replace Windows TCP with named pipe once tokio named_pipe ServerOptions
    // is stable. For now TCP 19002 is used but the Node.js bridge connects via
    // named pipe path — this mismatch needs resolution. The named pipe path is
    // \\.\pipe\bitterbot-orchestrator but tokio's named_pipe API requires a
    // different accept loop pattern than Unix/TCP.

    info!("IPC listening on {:?}", ipc_path);

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

    // Broadcast channel for pushing swarm events to all connected clients.
    // Capacity of 256 events; slow clients will miss events (lagged).
    let (event_broadcast_tx, _) = broadcast::channel::<serde_json::Value>(256);

    // Forward swarm events from mpsc → broadcast so all clients receive them.
    let event_broadcast_tx_fwd = event_broadcast_tx.clone();
    tokio::spawn(async move {
        let mut rx = event_rx;
        while let Some(event) = rx.recv().await {
            // If no clients are subscribed, send() returns Err — that's fine.
            let _ = event_broadcast_tx_fwd.send(event);
        }
        debug!("IPC event forwarder stopped (swarm event channel closed)");
    });

    let handle = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let cmd_tx = cmd_tx.clone();
                    let mut event_sub = event_broadcast_tx.subscribe();
                    tokio::spawn(async move {
                        let (reader, mut writer) = stream.into_split();
                        let mut lines = BufReader::new(reader).lines();

                        // Use select! to interleave:
                        // 1. Reading commands from the client
                        // 2. Pushing swarm events to the client
                        loop {
                            tokio::select! {
                                line_result = lines.next_line() => {
                                    match line_result {
                                        Ok(Some(line)) => {
                                            let line = line.trim().to_string();
                                            if line.is_empty() {
                                                continue;
                                            }
                                            if !handle_client_line(
                                                &line,
                                                &cmd_tx,
                                                &mut writer,
                                            ).await {
                                                break;
                                            }
                                        }
                                        Ok(None) => break, // client disconnected
                                        Err(e) => {
                                            debug!("IPC client read error: {}", e);
                                            break;
                                        }
                                    }
                                }
                                event = event_sub.recv() => {
                                    match event {
                                        Ok(ev) => {
                                            let event_line = match serde_json::to_string(&ev) {
                                                Ok(s) => format!("{}\n", s),
                                                Err(e) => {
                                                    warn!("Failed to serialize IPC event: {}", e);
                                                    continue;
                                                }
                                            };
                                            if writer.write_all(event_line.as_bytes()).await.is_err() {
                                                break;
                                            }
                                        }
                                        Err(broadcast::error::RecvError::Lagged(n)) => {
                                            warn!("IPC client lagged, missed {} events", n);
                                            // Continue — client will get the next events
                                        }
                                        Err(broadcast::error::RecvError::Closed) => {
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        debug!("IPC client disconnected");
                    });
                }
                Err(e) => {
                    error!("IPC accept error: {}", e);
                }
            }
        }
    });

    Ok((handle, cmd_rx))
}

/// Handle a single JSON-line command from a client. Returns false if the
/// connection should be closed.
async fn handle_client_line(
    line: &str,
    cmd_tx: &mpsc::UnboundedSender<IpcCommand>,
    #[cfg(unix)]
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    #[cfg(windows)]
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
) -> bool {
    let msg: IpcMessage = match serde_json::from_str(line) {
        Ok(m) => m,
        Err(e) => {
            warn!("Invalid IPC message: {}", e);
            return true; // continue reading
        }
    };

    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();

    let cmd = match msg.msg_type.as_str() {
        "publish_skill" => {
            let payload: SkillPayload = match serde_json::from_value(msg.payload) {
                Ok(p) => p,
                Err(e) => {
                    warn!("Invalid publish_skill payload: {}", e);
                    return true;
                }
            };
            IpcCommand::PublishSkill {
                id: msg.id,
                payload,
                respond: resp_tx,
            }
        }
        "get_peers" => IpcCommand::GetPeers {
            id: msg.id,
            respond: resp_tx,
        },
        "get_stats" => IpcCommand::GetStats {
            id: msg.id,
            respond: resp_tx,
        },
        "get_identity" => IpcCommand::GetIdentity {
            id: msg.id,
            respond: resp_tx,
        },
        "compute_eigentrust" => {
            let payload: EigenTrustPayload = match serde_json::from_value(msg.payload) {
                Ok(p) => p,
                Err(e) => {
                    warn!("Invalid compute_eigentrust payload: {}", e);
                    return true;
                }
            };
            IpcCommand::ComputeEigenTrust {
                id: msg.id,
                payload,
                respond: resp_tx,
            }
        }
        "sign_as_management" => {
            let payload: SkillPayload = match serde_json::from_value(msg.payload) {
                Ok(p) => p,
                Err(e) => {
                    warn!("Invalid sign_as_management payload: {}", e);
                    return true;
                }
            };
            IpcCommand::SignAsManagement {
                id: msg.id,
                payload,
                respond: resp_tx,
            }
        }
        "publish_weather" => {
            let payload: WeatherPayload = match serde_json::from_value(msg.payload) {
                Ok(p) => p,
                Err(e) => {
                    warn!("Invalid publish_weather payload: {}", e);
                    return true;
                }
            };
            IpcCommand::PublishWeather {
                id: msg.id,
                payload,
                respond: resp_tx,
            }
        }
        "publish_bounty" => {
            let payload: BountyPayload = match serde_json::from_value(msg.payload) {
                Ok(p) => p,
                Err(e) => {
                    warn!("Invalid publish_bounty payload: {}", e);
                    return true;
                }
            };
            IpcCommand::PublishBounty {
                id: msg.id,
                payload,
                respond: resp_tx,
            }
        }
        "publish_telemetry" => {
            let payload: TelemetryPayload = match serde_json::from_value(msg.payload) {
                Ok(p) => p,
                Err(e) => {
                    warn!("Invalid publish_telemetry payload: {}", e);
                    return true;
                }
            };
            IpcCommand::PublishTelemetry {
                id: msg.id,
                payload,
                respond: resp_tx,
            }
        }
        "publish_query" => {
            let payload: QueryPayload = match serde_json::from_value(msg.payload) {
                Ok(p) => p,
                Err(e) => {
                    warn!("Invalid publish_query payload: {}", e);
                    return true;
                }
            };
            IpcCommand::PublishQuery {
                id: msg.id,
                payload,
                respond: resp_tx,
            }
        }
        "get_network_census" => IpcCommand::GetNetworkCensus {
            id: msg.id,
            respond: resp_tx,
        },
        "get_anomaly_alerts" => IpcCommand::GetAnomalyAlerts {
            id: msg.id,
            respond: resp_tx,
        },
        "propagate_ban" => {
            let peer_pubkey = msg.payload.get("peer_pubkey")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let reason = msg.payload.get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("management ban")
                .to_string();
            IpcCommand::PropagateBan {
                id: msg.id,
                peer_pubkey,
                reason,
                respond: resp_tx,
            }
        }
        // PLAN-14 Pillar 4: computer use over IPC.
        "computer_screenshot" => {
            let payload: crate::computer::ScreenshotArgs =
                serde_json::from_value(msg.payload).unwrap_or_default();
            IpcCommand::ComputerScreenshot { id: msg.id, payload, respond: resp_tx }
        }
        "computer_screen_size" => {
            let payload: crate::computer::ScreenshotArgs =
                serde_json::from_value(msg.payload).unwrap_or_default();
            IpcCommand::ComputerScreenSize { id: msg.id, payload, respond: resp_tx }
        }
        "computer_mouse_move" => {
            let payload: crate::computer::MouseMoveArgs = match serde_json::from_value(msg.payload) {
                Ok(p) => p,
                Err(e) => {
                    warn!("Invalid computer_mouse_move payload: {}", e);
                    return true;
                }
            };
            IpcCommand::ComputerMouseMove { id: msg.id, payload, respond: resp_tx }
        }
        "computer_mouse_click" => {
            let payload: crate::computer::MouseClickArgs =
                serde_json::from_value(msg.payload).unwrap_or_default();
            IpcCommand::ComputerMouseClick { id: msg.id, payload, respond: resp_tx }
        }
        "computer_type" => {
            let payload: crate::computer::TypeArgs = match serde_json::from_value(msg.payload) {
                Ok(p) => p,
                Err(e) => {
                    warn!("Invalid computer_type payload: {}", e);
                    return true;
                }
            };
            IpcCommand::ComputerType { id: msg.id, payload, respond: resp_tx }
        }
        "computer_key" => {
            let payload: crate::computer::KeyArgs = match serde_json::from_value(msg.payload) {
                Ok(p) => p,
                Err(e) => {
                    warn!("Invalid computer_key payload: {}", e);
                    return true;
                }
            };
            IpcCommand::ComputerKey { id: msg.id, payload, respond: resp_tx }
        }
        other => {
            warn!("Unknown IPC message type: {}", other);
            return true;
        }
    };

    if cmd_tx.send(cmd).is_err() {
        error!("IPC command channel closed");
        return false;
    }

    // Wait for response and send back
    if let Ok(response) = resp_rx.await {
        let response_line = match serde_json::to_string(&response) {
            Ok(s) => format!("{}\n", s),
            Err(e) => {
                warn!("Failed to serialize IPC response: {}", e);
                return true;
            }
        };
        if writer.write_all(response_line.as_bytes()).await.is_err() {
            return false;
        }
    }

    true
}
