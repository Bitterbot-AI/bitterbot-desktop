/**
 * Stage 4 of the circles P2P transport plan: point-to-point circle RPC over
 * libp2p request-response (`/bitterbot/circle-rpc/1`).
 *
 * This is the glue that lets circle verbs with request/response semantics —
 * join, welcome, events.since, and ordinary deliveries wanting a delivery
 * receipt — skip HTTP when a member's PeerId is known. Server side: inbound
 * requests dispatch through the SAME `handleCircleMethod` as an HTTP dial
 * (membership auth, scope checks, injection scan, dedupe all identical — the
 * transport buys reach, never trust). Client side: `dialCircleRpc` sends
 * `{method, params}` as opaque base64 and returns the peer's outcome.
 *
 * Delivery order after this lands: P2P dial (when a verified PeerId is
 * known) → HTTP direct dial → mailbox. HTTP stays as fallback deliberately:
 * the mailbox IS HTTP by design (offline story), fleet skew needs a healing
 * path, and the P2P leg is the youngest transport — see the transport plan.
 *
 * Capability latch: a daemon without the circle-rpc verbs (pre-0.2.2) is
 * detected on the first dial (fast "unknown message type" answer from
 * 0.2.x's fail-fast IPC, or the 2s enqueue timeout) and P2P dialing latches
 * off for the process — HTTP delivery is unaffected.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadOrCreateBoxKeys, type BoxKeyPair } from "./box-crypto.js";

const log = createSubsystemLogger("circles/p2p-rpc");

export interface CircleRpcBridge {
  circleRequest(peerId: string, dataB64: string, timeoutMs?: number): Promise<string>;
  circleRespond(requestId: number, dataB64: string): Promise<void>;
  onCircleRequest(
    cb: (event: { request_id: number; from_peer_id: string; data_b64: string }) => void,
  ): () => void;
  getIdentity(): Promise<{ pubkey: string; peerId: string; nodeTier: string }>;
}

type ActiveP2p = { bridge: CircleRpcBridge; localPeerId: string | null };

let active: ActiveP2p | null = null;
let latchedOff = false;

/** The local node's libp2p PeerId (for join/presence bindings), or null. */
export function getLocalPeerId(): string | null {
  return active?.localPeerId ?? null;
}

/** True when P2P circle dialing is available (bridge up, not latched off). */
export function circleP2pAvailable(): boolean {
  return active !== null && !latchedOff;
}

/** Test hook. */
export function setCircleP2pForTests(p2p: ActiveP2p | null, latched = false): void {
  active = p2p;
  latchedOff = latched;
}

function isCapabilityError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("unknown message type") || msg.includes("circle_request timed out");
}

export type P2pRpcOutcome =
  | { ok: true; result?: Record<string, unknown> }
  | { ok: false; error: string; refused?: boolean };

/**
 * Dial a circle verb at a peer over the mesh. Mirrors circleRpc's outcome
 * shape: `refused` means the peer ANSWERED with an application error (do not
 * retry via mailbox); a plain error means the transport failed (fall back).
 */
export async function dialCircleRpc(
  peerId: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<P2pRpcOutcome> {
  if (!active || latchedOff) {
    return { ok: false, error: "p2p dial unavailable" };
  }
  const payload = Buffer.from(JSON.stringify({ method, params }), "utf-8").toString("base64");
  try {
    const respB64 = await active.bridge.circleRequest(peerId, payload, timeoutMs);
    const body = JSON.parse(Buffer.from(respB64, "base64").toString("utf-8")) as {
      ok?: boolean;
      result?: Record<string, unknown>;
      error?: string;
    };
    if (body.ok) {
      return { ok: true, result: body.result };
    }
    // The peer processed the request and refused it — definitive, like an
    // HTTP-level JSON-RPC error (bad secret, no scope, rate limited).
    return { ok: false, refused: true, error: body.error ?? "rpc error" };
  } catch (err) {
    if (isCapabilityError(err)) {
      latchedOff = true;
      log.warn(
        `orchestrator daemon does not serve circle-rpc verbs (pre-0.2.2 build?) — ` +
          `p2p dialing disabled for this run; HTTP delivery unaffected (${String(err)})`,
      );
    }
    return { ok: false, error: String(err) };
  }
}

/**
 * Start the P2P circle-RPC transport: wire inbound requests into the circle
 * verb dispatcher and cache the local PeerId for envelope bindings. Call once
 * at gateway startup when the orchestrator bridge is available.
 */
export function startCircleP2pTransport(deps: {
  bridge: CircleRpcBridge;
  resolveCirclesDb: () => Promise<DatabaseSync | undefined>;
  /** Injectable for tests; defaults to the node's real box keys. */
  boxKeys?: BoxKeyPair;
}): { stop: () => void } {
  const state: ActiveP2p = { bridge: deps.bridge, localPeerId: null };
  active = state;
  latchedOff = false;
  void deps.bridge
    .getIdentity()
    .then((id) => {
      state.localPeerId = id.peerId || null;
    })
    .catch((err) => log.debug(`identity fetch failed: ${String(err)}`));

  const unsub = deps.bridge.onCircleRequest((event) => {
    void (async () => {
      const respond = async (body: unknown) => {
        try {
          await deps.bridge.circleRespond(
            event.request_id,
            Buffer.from(JSON.stringify(body), "utf-8").toString("base64"),
          );
        } catch (err) {
          log.debug(`circle-rpc respond failed: ${String(err)}`);
        }
      };
      let method = "";
      let params: unknown = {};
      try {
        const req = JSON.parse(Buffer.from(event.data_b64, "base64").toString("utf-8")) as {
          method?: string;
          params?: unknown;
        };
        method = typeof req.method === "string" ? req.method : "";
        params = req.params ?? {};
      } catch {
        await respond({ ok: false, error: "malformed request" });
        return;
      }
      // ONLY circle verbs — this transport must never widen into a general
      // RPC surface (no mailbox/*, no gateway methods). The circle handlers
      // carry their own auth; an unauthorized envelope is refused exactly as
      // it would be over HTTP.
      if (!method.startsWith("circle/")) {
        await respond({ ok: false, error: "method not allowed" });
        return;
      }
      const db = await deps.resolveCirclesDb();
      if (!db) {
        await respond({ ok: false, error: "node not ready" });
        return;
      }
      try {
        const { handleCircleMethod } = await import("../gateway/a2a/circles.js");
        const boxKeys = deps.boxKeys ?? loadOrCreateBoxKeys();
        const outcome = handleCircleMethod(method, params, db, Date.now(), { boxKeys });
        await respond(
          outcome.ok
            ? { ok: true, result: outcome.result }
            : { ok: false, error: outcome.error.message },
        );
      } catch (err) {
        await respond({ ok: false, error: `dispatch failed: ${String(err)}` });
      }
    })();
  });
  log.info("circle p2p rpc transport active (request-response over the mesh)");
  return {
    stop: () => {
      unsub();
      if (active === state) active = null;
    },
  };
}
