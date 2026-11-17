import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, type KeyPair } from "../../../commerce/envelope.js";
import type { BitterbotConfig } from "../../../config/config.js";
import type { OrchestratorBridge } from "../../../infra/orchestrator-bridge.js";
import { loadPeerSkillCards, resetSkillCardCachesForTest } from "../skill-cards-runtime.js";
import { resetSkillPriorCachesForTest } from "../skill-prior-runtime.js";
import { SkillPriorLedger } from "../skill-prior.js";
import { PACKAGE_TOPIC, PackageMesh } from "./mesh.js";
import type { CollectiveRuntime } from "./runtime.js";

const state = vi.hoisted(() => ({
  config: {} as unknown,
  key: null as unknown,
}));
vi.mock("../../../config/config.js", () => ({ loadConfig: () => state.config }));
vi.mock("../skill-cards-runtime.js", async (original) => ({
  ...(await original<typeof import("../skill-cards-runtime.js")>()),
  skillCardKey: () => state.key,
}));

type Listener = (event: { topic: string; from_peer_id: string; data_b64: string }) => void;

/** A gossip topic shared by every mesh built on it. */
function gossip() {
  const listeners: Array<{ id: string; fn: Listener }> = [];
  const sent: string[] = [];
  const bridge = (id: string) =>
    ({
      subscribeCircleTopic: async () => undefined,
      unsubscribeCircleTopic: async () => undefined,
      onCircleTopicMessage: (fn: Listener) => {
        listeners.push({ id, fn });
        return () => undefined;
      },
      publishCircleTopic: async (topic: string, data_b64: string) => {
        sent.push(data_b64);
        // Delivery is asynchronous, as on the real mesh.
        await Promise.resolve();
        for (const l of listeners) {
          if (l.id !== id) {
            l.fn({ topic, from_peer_id: id, data_b64 });
          }
        }
      },
    }) as unknown as OrchestratorBridge;
  return { bridge, sent };
}

describe("skill cards over the package mesh", () => {
  let dir: string;
  const node = (name: string, key: KeyPair, enabled = true): BitterbotConfig =>
    ({
      skills: {
        collective: { enabled, publicMesh: enabled },
        prior: {
          ledgerPath: path.join(dir, `${name}-prior.json`),
          peersPath: path.join(dir, `${name}-peers.json`),
        },
      },
      __key: key,
    }) as unknown as BitterbotConfig;
  const use = (cfg: BitterbotConfig) => {
    state.config = cfg;
    state.key = (cfg as unknown as { __key: KeyPair }).__key;
  };
  const mesh = (bridge: OrchestratorBridge, on = true) =>
    new PackageMesh(
      bridge,
      { store: { db: new DatabaseSync(":memory:") } } as unknown as CollectiveRuntime,
      () => on,
    );
  const hash = createHash("sha256").update("# skill\n").digest("hex");
  function learn(cfg: BitterbotConfig, outcome: 0 | 1) {
    const ledger = new SkillPriorLedger();
    ledger.update({
      cell: "default",
      skill: { name: "private-name", hash },
      outcome,
      runId: "r1",
      gate: true,
      verified: true,
    });
    fs.writeFileSync(cfg.skills!.prior!.ledgerPath!, ledger.toJSON());
    resetSkillPriorCachesForTest();
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cards-"));
    resetSkillPriorCachesForTest();
    resetSkillCardCachesForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("announces a node's verified outcomes and the receiving node stores them", async () => {
    const net = gossip();
    const a = node("a", generateKeyPair());
    const b = node("b", generateKeyPair());
    const meshA = mesh(net.bridge("peer-a"));
    const meshB = mesh(net.bridge("peer-b"));
    await meshA.start();
    await meshB.start();

    use(a);
    learn(a, 1);
    // The receiver reads its own config when the announcement lands.
    const publishing = meshA.publishCards();
    use(b);
    expect(await publishing).toBe(true);

    const wire = Buffer.from(net.sent[0]!, "base64").toString("utf8");
    expect(net.sent[0]!.length).toBeLessThanOrEqual(24_000);
    expect(wire).not.toContain("private-name");
    const stored = loadPeerSkillCards(b, Date.now());
    expect(stored).toHaveLength(1);
    expect(stored[0]!.origin).toBe(
      `ed25519:${(a as unknown as { __key: KeyPair }).__key.publicKeyHex}`,
    );
    expect(stored[0]!.cells).toEqual({ default: { [hash]: { passed: 1, runs: 1 } } });
    await meshA.stop();
    await meshB.stop();
  });

  it("does not announce an unchanged bundle again, nothing unverified, and nothing when disabled", async () => {
    const net = gossip();
    const a = node("a", generateKeyPair());
    use(a);
    const meshA = mesh(net.bridge("peer-a"));
    expect(await meshA.publishCards()).toBe(false);
    learn(a, 1);
    expect(await meshA.publishCards(1_000)).toBe(true);
    expect(await meshA.publishCards(2_000)).toBe(false);
    expect(await meshA.publishCards(1_000 + 7 * 3_600_000)).toBe(true);
    expect(net.sent).toHaveLength(2);

    state.config = { skills: { ...a.skills, prior: { ...a.skills!.prior, peerEvidence: false } } };
    expect(await meshA.publishCards(9e12)).toBe(false);
    use(a);
    expect(await mesh(net.bridge("peer-off"), false).publishCards()).toBe(false);
  });

  it("ignores forged cards and cards when peer evidence is off", async () => {
    const net = gossip();
    const b = node("b", generateKeyPair());
    use(b);
    const meshB = mesh(net.bridge("peer-b"));
    await meshB.start();
    const sender = net.bridge("peer-x");
    const forged = {
      protocol: "bitterbot/skill-cards/2",
      origin: `ed25519:${generateKeyPair().publicKeyHex}`,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      cells: { default: { [hash]: { passed: 1, runs: 1 } } },
      signature: "0".repeat(128),
    };
    await sender.publishCircleTopic(
      PACKAGE_TOPIC,
      Buffer.from(JSON.stringify({ type: "cards", body: forged })).toString("base64"),
    );
    expect(loadPeerSkillCards(b, Date.now())).toHaveLength(0);
    expect(fs.existsSync(b.skills!.prior!.peersPath!)).toBe(false);
    await meshB.stop();
  });
});
