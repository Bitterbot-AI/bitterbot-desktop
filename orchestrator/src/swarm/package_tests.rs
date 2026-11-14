//! Real loopback swarms. Empty bootstrap lists keep this test off the public mesh.
use super::*;
use base64::Engine;
use tokio::sync::oneshot;

#[tokio::test]
async fn package_objects_round_trip_over_two_private_swarm_sidecars() {
    // Deterministic test-only identities; these swarms never join the public mesh.
    let key_a = SigningKey::from_bytes(&[11u8; 32]);
    let key_b = SigningKey::from_bytes(&[22u8; 32]);
    let (mut a, mut events_a) = build_swarm(
        &key_a,
        "/ip4/127.0.0.1/tcp/0",
        &[],
        "edge",
        vec![],
        RelayMode::Off,
        &[],
        None,
    )
    .await
    .unwrap();
    let (mut b, mut events_b) = build_swarm(
        &key_b,
        "/ip4/127.0.0.1/tcp/0",
        &[],
        "edge",
        vec![],
        RelayMode::Off,
        &[],
        None,
    )
    .await
    .unwrap();
    let address = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let libp2p::swarm::SwarmEvent::NewListenAddr { address, .. } =
                b.swarm.select_next_some().await
            {
                break address;
            }
        }
    })
    .await
    .unwrap();
    let peer_b = b.local_peer_id;
    a.swarm
        .dial(address.with(libp2p::multiaddr::Protocol::P2p(peer_b)))
        .unwrap();
    let (tx_a, rx_a) = mpsc::unbounded_channel();
    let (tx_b, rx_b) = mpsc::unbounded_channel();
    let loop_a = tokio::spawn(async move {
        let _ = a.run_event_loop(rx_a).await;
    });
    let loop_b = tokio::spawn(async move {
        let _ = b.run_event_loop(rx_b).await;
    });
    let test = tokio::time::timeout(Duration::from_secs(20), async {
        loop { if events_a.recv().await.unwrap()["type"] == "peer_connected" { break; } }
        let request = serde_json::json!({"method":"skill-package/1/object","params":{"releaseId":"a".repeat(64),"objectHash":"b".repeat(64),"offset":24576}});
        let request_b64 = base64::engine::general_purpose::STANDARD.encode(request.to_string());
        let (ack_tx, ack_rx) = oneshot::channel();
        tx_a.send(IpcCommand::CircleRequest { id: "package-request".into(), peer_id: peer_b.to_string(), data_b64: request_b64.clone(), respond: ack_tx }).unwrap();
        assert_eq!(ack_rx.await.unwrap()["payload"]["ok"], true);
        let incoming = loop {
            let event = events_b.recv().await.unwrap();
            if event["type"] == "circle_request" { break event; }
        };
        assert_eq!(incoming["payload"]["data_b64"], request_b64);
        let object = vec![42u8; 24576];
        let response = serde_json::json!({"ok":true,"result":{"objectHash":"b".repeat(64),"offset":24576,"total":49152,"data":base64::engine::general_purpose::STANDARD.encode(&object)}});
        let response_b64 = base64::engine::general_purpose::STANDARD.encode(response.to_string());
        let (ack_tx, ack_rx) = oneshot::channel();
        tx_b.send(IpcCommand::CircleRespond { id: "package-response".into(), request_id: incoming["payload"]["request_id"].as_u64().unwrap(), data_b64: response_b64.clone(), respond: ack_tx }).unwrap();
        assert_eq!(ack_rx.await.unwrap()["payload"]["ok"], true);
        let received = loop { let event = events_a.recv().await.unwrap(); if event["type"] == "circle_response" { break event; } };
        assert_eq!(received["payload"]["ok"], true);
        assert_eq!(received["payload"]["data_b64"], response_b64);
    }).await;
    loop_a.abort();
    loop_b.abort();
    test.expect("Private sidecar package transfer timed out");
}
