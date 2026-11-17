import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, type KeyPair } from "../../commerce/envelope.js";
import type { SkillsPriorConfig } from "../../config/types.skills.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import {
  MAX_NEW_ORIGINS_PER_WINDOW,
  MAX_PEER_ORIGINS,
  loadPeerSkillCards,
  ownSkillCards,
  resetSkillCardCachesForTest,
  storePeerSkillCards,
} from "./skill-cards-runtime.js";
import { type CellRecords, exportSkillCards } from "./skill-cards.js";
import { applySkillPriorForRun, resetSkillPriorCachesForTest } from "./skill-prior-runtime.js";
import { SkillPriorLedger } from "./skill-prior.js";

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent: vi.fn() }));

const NAMES = ["alpha", "beta", "gamma"] as const;
const PROMPT = `<available_skills>
${NAMES.map(
  (n) => `  <skill>
    <name>${n}</name>
    <description>${n}.</description>
    <location>/skills/${n}/SKILL.md</location>
  </skill>`,
).join("\n")}
</available_skills>
`;

describe("skill cards runtime", () => {
  let dir: string;
  let ledgerPath: string;
  let peersPath: string;
  const files: Record<string, string> = {};
  const hash: Record<string, string> = {};
  const now = Date.now();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-cards-runtime-"));
    ledgerPath = path.join(dir, "prior.json");
    peersPath = path.join(dir, "peers.json");
    for (const n of NAMES) {
      const content = `# ${n}\nProcedure ${n}.\n`;
      files[n] = path.join(dir, `${n}.md`);
      fs.writeFileSync(files[n], content);
      hash[n] = createHash("sha256").update(content).digest("hex");
    }
    resetSkillPriorCachesForTest();
    resetSkillCardCachesForTest();
    vi.mocked(emitAgentEvent).mockClear();
  });
  afterEach(() => {
    resetSkillPriorCachesForTest();
    resetSkillCardCachesForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cfg = (prior: SkillsPriorConfig = {}) => ({
    skills: { prior: { enabled: true, ledgerPath, peersPath, ...prior } },
  });
  const apply = (prior: SkillsPriorConfig = {}) =>
    applySkillPriorForRun({
      prompt: PROMPT,
      runId: "run",
      skills: NAMES.map((name) => ({ name, filePath: files[name]! })),
      config: cfg(prior),
    });
  const peer = (cells: CellRecords, key: KeyPair = generateKeyPair(), at = now) =>
    exportSkillCards({ cells, key, now: at })!;
  const receive = (cells: CellRecords, key?: KeyPair, at = now) =>
    storePeerSkillCards(cfg(), peer(cells, key, at), { now });
  function ownOutcome(name: string, outcome: 0 | 1, cell = "default", runId = `${cell}-${name}`) {
    const ledger = fs.existsSync(ledgerPath)
      ? SkillPriorLedger.fromJSON(fs.readFileSync(ledgerPath, "utf8"))
      : new SkillPriorLedger();
    ledger.update({
      cell,
      skill: { name, hash: hash[name]! },
      outcome,
      runId,
      gate: true,
      verified: true,
    });
    fs.writeFileSync(ledgerPath, ledger.toJSON());
    resetSkillPriorCachesForTest();
    return ledger;
  }
  const evidenceOf = (prompt: string, name: string) =>
    new RegExp(`<name>${name}</name>[\\s\\S]*?</skill>`)
      .exec(prompt)![0]
      .match(/<evidence>(.*)<\/evidence>/)?.[1];

  it("leaves the index byte for byte as before when no peer verdict applies", () => {
    ownOutcome("alpha", 1);
    const before = apply();
    expect(evidenceOf(before, "alpha")).toBe("ACCEPTED every time it was used (1 use)");
    // One peer is below the quorum; a peer record for a skill we tried is not shown.
    receive({ default: { [hash.beta!]: { passed: 1, runs: 1 } } });
    receive({ default: { [hash.alpha!]: { passed: 0, runs: 1 } } });
    expect(apply()).toBe(before);
  });

  it("shows a quorum verdict beside an untried skill and names whose runs are whose", () => {
    ownOutcome("alpha", 0);
    receive({ default: { [hash.beta!]: { passed: 2, runs: 2 } } });
    receive({
      default: { [hash.beta!]: { passed: 1, runs: 1 }, [hash.gamma!]: { passed: 0, runs: 1 } },
    });
    const out = apply();
    expect(evidenceOf(out, "alpha")).toBe(
      "Your own runs here: REJECTED every time it was used (1 use).",
    );
    expect(evidenceOf(out, "beta")).toBe(
      "Runs here by 2 other agents: ACCEPTED every time it was used (2 uses).",
    );
    expect(evidenceOf(out, "gamma")).toBeUndefined();
    const event = vi.mocked(emitAgentEvent).mock.calls.at(-1)![0].data as {
      prior: { peerAnnotated: string[]; peers: { peers: number; dropped: number } };
    };
    expect(event.prior.peerAnnotated).toEqual(["beta"]);
    expect(event.prior.peers).toMatchObject({ peers: 2, dropped: 0 });
  });

  it("drops a peer that contradicts the node's own outcomes, so its vote cannot make a quorum", () => {
    for (const cell of ["c1", "c2", "c3"]) {
      ownOutcome("alpha", 1, cell);
    }
    const lies = Object.fromEntries(
      ["c1", "c2", "c3"].map((c) => [c, { [hash.alpha!]: { passed: 0, runs: 1 } }]),
    );
    receive({ ...lies, default: { [hash.beta!]: { passed: 1, runs: 1 } } });
    receive({ default: { [hash.beta!]: { passed: 1, runs: 1 } } });
    const out = apply();
    expect(evidenceOf(out, "beta")).toBeUndefined();
    receive({ default: { [hash.beta!]: { passed: 1, runs: 1 } } });
    resetSkillCardCachesForTest();
    expect(evidenceOf(apply(), "beta")).toBe(
      "Runs here by 2 other agents: ACCEPTED every time it was used (2 uses).",
    );
  });

  it("can be switched off, follows the quorum setting, and stays off with evidence off", () => {
    receive({ default: { [hash.beta!]: { passed: 1, runs: 1 } } });
    expect(evidenceOf(apply({ peerQuorum: 1 }), "beta")).toBe(
      "Runs here by 1 other agent: ACCEPTED every time it was used (1 use).",
    );
    expect(apply({ peerQuorum: 1, peerEvidence: false })).toBe(PROMPT);
    expect(apply({ peerQuorum: 1, evidence: "off" })).toBe(PROMPT);
    expect(apply({ peerQuorum: 1, enabled: false })).toBe(PROMPT);
  });

  it("ignores a peer record for a skill whose content differs from the local copy", () => {
    const other = "0".repeat(64);
    receive({ default: { [other]: { passed: 1, runs: 1 } } });
    receive({ default: { [other]: { passed: 1, runs: 1 } } });
    expect(apply()).toBe(PROMPT);
  });

  it("keeps one bundle per origin: newer replaces, older and too-frequent are refused", () => {
    const key = generateKeyPair();
    const cells = { default: { [hash.beta!]: { passed: 1, runs: 1 } } };
    expect(receive(cells, key, now - 3_600_000).stored).toBe(true);
    expect(receive(cells, key, now - 7_200_000)).toMatchObject({ stored: false });
    expect(receive(cells, key, now - 3_600_000 + 1_000)).toEqual({
      stored: false,
      reason: "replaced too recently",
    });
    expect(receive({ default: { [hash.beta!]: { passed: 0, runs: 1 } } }, key, now).stored).toBe(
      true,
    );
    const kept = loadPeerSkillCards(cfg(), now);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.cells.default![hash.beta!]).toEqual({ passed: 0, runs: 1 });
  });

  it("refuses tampered and own bundles, admits new origins slowly, and re-verifies the file", () => {
    const mine = generateKeyPair();
    const cells = { default: { [hash.beta!]: { passed: 1, runs: 1 } } };
    const tampered = peer(cells);
    tampered.cells.default![hash.beta!] = { passed: 0, runs: 1 };
    expect(storePeerSkillCards(cfg(), tampered, { now })).toEqual({
      stored: false,
      reason: "bad signature",
    });
    expect(
      storePeerSkillCards(cfg(), peer(cells, mine), { now, self: `ed25519:${mine.publicKeyHex}` }),
    ).toEqual({ stored: false, reason: "own bundle" });
    // New origins are admitted slowly, and a full store keeps recent bundles.
    for (let i = 0; i < MAX_NEW_ORIGINS_PER_WINDOW; i++) {
      expect(receive(cells, generateKeyPair()).stored).toBe(true);
    }
    expect(receive(cells, generateKeyPair())).toEqual({
      stored: false,
      reason: "too many new origins",
    });
    const old = generateKeyPair();
    const week = 8 * 86_400_000;
    resetSkillCardCachesForTest();
    expect(receive(cells, old, now - week).stored).toBe(true);
    for (let i = MAX_NEW_ORIGINS_PER_WINDOW + 1; i < MAX_PEER_ORIGINS; i++) {
      if (i % MAX_NEW_ORIGINS_PER_WINDOW === 0) {
        resetSkillCardCachesForTest();
      }
      expect(receive(cells, generateKeyPair()).stored).toBe(true);
    }
    resetSkillCardCachesForTest();
    expect(loadPeerSkillCards(cfg(), now)).toHaveLength(MAX_PEER_ORIGINS);
    // The one old bundle makes room for a newcomer; after that the store is full.
    expect(receive(cells, generateKeyPair()).stored).toBe(true);
    expect(receive(cells, generateKeyPair())).toEqual({ stored: false, reason: "peer store full" });
    const kept = loadPeerSkillCards(cfg(), now);
    expect(kept).toHaveLength(MAX_PEER_ORIGINS);
    expect(kept.some((b) => b.origin === `ed25519:${old.publicKeyHex}`)).toBe(false);
    // A bundle edited on disk no longer verifies and is not used.
    const raw = JSON.parse(fs.readFileSync(peersPath, "utf8")) as {
      bundles: Record<string, { cells: CellRecords }>;
    };
    const victim = Object.keys(raw.bundles)[0]!;
    raw.bundles[victim]!.cells.default![hash.beta!] = { passed: 0, runs: 1 };
    fs.writeFileSync(peersPath, JSON.stringify(raw));
    resetSkillCardCachesForTest();
    expect(loadPeerSkillCards(cfg(), now).some((b) => b.origin === victim)).toBe(false);
  });

  it("exports the node's own verified outcomes by content hash and nothing else", () => {
    const key = generateKeyPair();
    expect(ownSkillCards(new SkillPriorLedger(), key, now)).toBeNull();
    ownOutcome("alpha", 1);
    const ledger = ownOutcome("beta", 0);
    const unverified = new SkillPriorLedger();
    unverified.update({
      cell: "default",
      skill: { name: "alpha", hash: hash.alpha! },
      outcome: 1,
      runId: "r",
      gate: true,
    });
    expect(ownSkillCards(unverified, key, now)).toBeNull();
    const bundle = ownSkillCards(ledger, key, now)!;
    expect(bundle.cells).toEqual({
      default: { [hash.alpha!]: { passed: 1, runs: 1 }, [hash.beta!]: { passed: 0, runs: 1 } },
    });
    expect(JSON.stringify(bundle)).not.toMatch(/alpha|beta/);
  });
});
