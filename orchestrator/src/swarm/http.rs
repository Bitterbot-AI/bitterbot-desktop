use crate::swarm::SharedStats;
use axum::{
    extract::{ConnectInfo, Request, State},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::get,
    Json, Router,
};
use http::{HeaderMap, StatusCode};
use serde::Serialize;
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio_stream::StreamExt;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, debug};

/// Per-IP rate limiter for the HTTP dashboard API (60 requests/min per IP).
const HTTP_MAX_REQUESTS_PER_MINUTE: usize = 60;

struct HttpRateLimiter {
    requests: HashMap<IpAddr, Vec<Instant>>,
}

impl HttpRateLimiter {
    fn new() -> Self {
        Self { requests: HashMap::new() }
    }

    fn check(&mut self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let timestamps = self.requests.entry(ip).or_default();
        timestamps.retain(|ts| now.duration_since(*ts).as_secs() < 60);
        if timestamps.len() >= HTTP_MAX_REQUESTS_PER_MINUTE {
            return false;
        }
        timestamps.push(now);
        true
    }
}

#[derive(Clone)]
struct AppState {
    stats: SharedStats,
    auth_token: Option<String>,
    rate_limiter: Arc<Mutex<HttpRateLimiter>>,
}

#[derive(Serialize)]
struct PeerDetailResponse {
    addrs: Vec<String>,
    connected_at: u64,
    skills_received_from: u64,
    reputation_score: f64,
}

#[derive(Serialize)]
struct PeersResponse {
    peer_id: String,
    connected_peers: usize,
    peer_details: HashMap<String, PeerDetailResponse>,
}

#[derive(Serialize)]
struct StatsResponse {
    peer_id: String,
    connected_peers: usize,
    skills_published: u64,
    skills_received: u64,
    uptime_secs: u64,
    mesh_peers_count: usize,
    subscribed_topics: Vec<String>,
    listen_addrs: Vec<String>,
}

#[derive(Serialize)]
struct ContributionsResponse {
    skills_published: u64,
    skills_received: u64,
    uptime_hours: f64,
    score: f64,
}

#[derive(Serialize)]
struct NetworkResponse {
    peer_id: String,
    connected_peers: usize,
    peer_details: HashMap<String, PeerDetailResponse>,
    listen_addrs: Vec<String>,
    uptime_secs: u64,
    mesh_peers_count: usize,
    subscribed_topics: Vec<String>,
}

#[derive(Serialize)]
struct LeaderboardEntry {
    peer_id: String,
    skills_received_from: u64,
    reputation_score: f64,
    connected_at: u64,
}

#[derive(Serialize)]
struct LeaderboardResponse {
    self_peer_id: String,
    self_score: f64,
    peers: Vec<LeaderboardEntry>,
}

async fn auth_middleware(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    // Per-IP rate limiting
    {
        let mut limiter = state.rate_limiter.lock().unwrap_or_else(|e| e.into_inner());
        if !limiter.check(addr.ip()) {
            debug!("HTTP rate limit exceeded for {}", addr.ip());
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
    }

    if let Some(ref expected) = state.auth_token {
        let provided = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        match provided {
            Some(token) if token == expected.as_str() => {}
            _ => return StatusCode::UNAUTHORIZED.into_response(),
        }
    }
    next.run(request).await
}

async fn get_peers(State(state): State<AppState>) -> Json<PeersResponse> {
    let stats = state.stats.lock().unwrap_or_else(|e| e.into_inner());
    let peer_details: HashMap<String, PeerDetailResponse> = stats
        .peer_details
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                PeerDetailResponse {
                    addrs: v.addrs.clone(),
                    connected_at: v.connected_at,
                    skills_received_from: v.skills_received_from,
                    reputation_score: v.reputation_score,
                },
            )
        })
        .collect();
    Json(PeersResponse {
        peer_id: stats.peer_id.clone(),
        connected_peers: stats.connected_peers,
        peer_details,
    })
}

async fn get_stats(State(state): State<AppState>) -> Json<StatsResponse> {
    let stats = state.stats.lock().unwrap_or_else(|e| e.into_inner());
    Json(StatsResponse {
        peer_id: stats.peer_id.clone(),
        connected_peers: stats.connected_peers,
        skills_published: stats.skills_published,
        skills_received: stats.skills_received,
        uptime_secs: stats.uptime_secs,
        mesh_peers_count: stats.mesh_peers_count,
        subscribed_topics: stats.subscribed_topics.clone(),
        listen_addrs: stats.listen_addrs.clone(),
    })
}

async fn get_contributions(State(state): State<AppState>) -> Json<ContributionsResponse> {
    let stats = state.stats.lock().unwrap_or_else(|e| e.into_inner());
    let uptime_hours = stats.uptime_secs as f64 / 3600.0;
    let score = (stats.skills_published as f64 * 10.0) + uptime_hours * 0.1;
    Json(ContributionsResponse {
        skills_published: stats.skills_published,
        skills_received: stats.skills_received,
        uptime_hours,
        score,
    })
}

async fn get_network(State(state): State<AppState>) -> Json<NetworkResponse> {
    let stats = state.stats.lock().unwrap_or_else(|e| e.into_inner());
    let peer_details: HashMap<String, PeerDetailResponse> = stats
        .peer_details
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                PeerDetailResponse {
                    addrs: v.addrs.clone(),
                    connected_at: v.connected_at,
                    skills_received_from: v.skills_received_from,
                    reputation_score: v.reputation_score,
                },
            )
        })
        .collect();
    Json(NetworkResponse {
        peer_id: stats.peer_id.clone(),
        connected_peers: stats.connected_peers,
        peer_details,
        listen_addrs: stats.listen_addrs.clone(),
        uptime_secs: stats.uptime_secs,
        mesh_peers_count: stats.mesh_peers_count,
        subscribed_topics: stats.subscribed_topics.clone(),
    })
}

async fn get_leaderboard(State(state): State<AppState>) -> Json<LeaderboardResponse> {
    let stats = state.stats.lock().unwrap_or_else(|e| e.into_inner());

    // Self score
    let uptime_hours = stats.uptime_secs as f64 / 3600.0;
    let self_score = (stats.skills_published as f64 * 10.0) + uptime_hours * 0.1;

    // Rank connected peers by reputation_score (contribution score)
    let mut peers: Vec<LeaderboardEntry> = stats
        .peer_details
        .iter()
        .map(|(k, v)| LeaderboardEntry {
            peer_id: k.clone(),
            skills_received_from: v.skills_received_from,
            reputation_score: v.reputation_score,
            connected_at: v.connected_at,
        })
        .collect();

    // Sort descending by reputation_score
    peers.sort_by(|a, b| {
        b.reputation_score
            .partial_cmp(&a.reputation_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Json(LeaderboardResponse {
        self_peer_id: stats.peer_id.clone(),
        self_score,
        peers,
    })
}

async fn events(
    State(state): State<AppState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let stream = tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(
        std::time::Duration::from_secs(5),
    ))
    .map(move |_| {
        let stats = state.stats.lock().unwrap_or_else(|e| e.into_inner());
        let data = serde_json::json!({
            "connected_peers": stats.connected_peers,
            "skills_published": stats.skills_published,
            "skills_received": stats.skills_received,
            "uptime_secs": stats.uptime_secs,
            "mesh_peers_count": stats.mesh_peers_count,
            "subscribed_topics": stats.subscribed_topics,
        });
        Ok(Event::default().data(data.to_string()))
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub async fn serve_http(
    addr: &str,
    stats: SharedStats,
    auth_token: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let has_auth = auth_token.is_some();
    let state = AppState {
        stats,
        auth_token,
        rate_limiter: Arc::new(Mutex::new(HttpRateLimiter::new())),
    };

    // CORS: only allow localhost origins when auth is required.
    // Without auth, allow any origin but don't expose auth headers.
    let cors = if has_auth {
        CorsLayer::new()
            .allow_methods([http::Method::GET])
            .allow_origin("http://localhost:3000".parse::<http::HeaderValue>().unwrap())
            .allow_origin("http://127.0.0.1:3000".parse::<http::HeaderValue>().unwrap())
            .allow_headers([http::header::AUTHORIZATION, http::header::CONTENT_TYPE])
    } else {
        CorsLayer::new()
            .allow_methods([http::Method::GET])
            .allow_origin(Any)
            .allow_headers([http::header::CONTENT_TYPE])
    };

    let app = Router::new()
        .route("/api/peers", get(get_peers))
        .route("/api/stats", get(get_stats))
        .route("/api/contributions", get(get_contributions))
        .route("/api/network", get(get_network))
        .route("/api/leaderboard", get(get_leaderboard))
        .route("/events", get(events))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("HTTP API listening on {}", addr);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;

    Ok(())
}
