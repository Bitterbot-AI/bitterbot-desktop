# Bitterbot P2P Bootstrap Node
# Minimal image: just the Rust orchestrator daemon for DHT peer discovery.
# No agent, no gateway, no Node.js — pure libp2p networking.

FROM rust:1.82-slim-bookworm AS builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY orchestrator/Cargo.toml orchestrator/Cargo.lock ./
COPY orchestrator/src ./src

RUN cargo build --release

# ── Runtime ──
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/bitterbot-orchestrator /usr/local/bin/

# Keys directory — persistent volume mount point
RUN mkdir -p /data/keys

EXPOSE 9100
EXPOSE 9847

ENV RUST_LOG=info

ENTRYPOINT ["bitterbot-orchestrator"]
CMD [ \
  "--ipc-path", "/tmp/bitterbot-orchestrator.sock", \
  "--key-dir", "/data/keys", \
  "--listen-addr", "/ip4/0.0.0.0/tcp/9100", \
  "--http-addr", "0.0.0.0:9847" \
]
