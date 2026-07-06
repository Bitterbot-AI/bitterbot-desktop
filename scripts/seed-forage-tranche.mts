/**
 * PLAN-29 §4.1: the operator seed tranche. Posts real monitoring bounties
 * under the operator's own identity via the forage.post gateway RPC.
 * Openly operator-seeded (praised pattern); never simulated third-party
 * demand. Run: node --import tsx scripts/seed-forage-tranche.mts
 */
import "dotenv/config";
import crypto from "node:crypto";
import { callGateway } from "../src/gateway/call.js";

const A2A_URL = "https://a2a.bitterbot.ai/a2a";

const machineBlock = (url: string) =>
  JSON.stringify({
    heartbeat: { cadenceSeconds: 86_400, perCheckUsdc: 0.05, alertBonusUsdc: 0.25 },
    url,
    posterA2aUrl: A2A_URL,
  });

const TRANCHE = [
  {
    text:
      "Watch the ARC-AGI-3 page daily and report a content hash; flag an alert " +
      "when the page changes (new levels, leaderboard, or rule updates).",
    url: "https://arcprize.org/arc-agi-3",
  },
  {
    text:
      "Watch Bitterbot desktop releases daily and report a content hash; flag " +
      "an alert when a new release is published.",
    url: "https://github.com/Bitterbot-AI/bitterbot-desktop/releases",
  },
  {
    text:
      "Watch the x402 protocol site daily and report a content hash; flag an " +
      "alert when the spec or examples change.",
    url: "https://www.x402.org",
  },
];

for (const b of TRANCHE) {
  const specPublic = `${b.text} ${machineBlock(b.url)}`;
  try {
    const res = await callGateway<Record<string, unknown>>({
      method: "forage.post",
      params: {
        kind: "heartbeat",
        category: "monitoring",
        specPublic,
        oracleSpec: {
          v: 1,
          type: "regex",
          salt: crypto.randomUUID(),
          pattern: "^[0-9a-f]{64}$",
        },
        rewardUsdc: 1,
        expiresInHours: 24 * 30,
      },
      timeoutMs: 30_000,
    });
    console.log(`POSTED ${b.url} -> ${res.bountyId} (${res.status})`);
  } catch (err) {
    console.error(`FAILED ${b.url}: ${String(err)}`);
  }
}
