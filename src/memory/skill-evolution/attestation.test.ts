/**
 * PLAN-43 Phase 3: receiver-side attestations — signing, storage, the
 * Sybil-resistant trimmed-mean aggregate, and re-scoring on the node's own
 * (canonical + private) corpus.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId } from "../../commerce/envelope.js";
import { ensureColumn, ensureMemoryIndexSchema } from "../memory-schema.js";
import {
  aggregateAttestations,
  ATTEST_PROTOCOL,
  attestationScore,
  listAttestations,
  rescoreSkill,
  runAttestationSweep,
  signAttestation,
  skillContentSha256,
  storeAttestation,
  verifyAttestation,
  type SkillAttestation,
} from "./attestation.js";
import { DEFAULT_UNKNOWN_ATTESTER_WEIGHT } from "./attester-weight.js";

const KEY = generateKeyPair();

function att(over: Partial<SkillAttestation> = {}, key = KEY): SkillAttestation {
  return signAttestation(
    {
      protocol: ATTEST_PROTOCOL,
      content_sha256: "a".repeat(64),
      corpus_version: "canonical-g3-s1",
      corpus_seed: 1,
      private_suite_sha256: null,
      verdict: "accepted",
      wins: 6,
      losses: 0,
      ties: 2,
      p_value: 0.0156,
      regressions: 0,
      trials_per_task: 3,
      model: null,
      attested_at: Date.now(),
      node_pubkey: null,
      ...over,
    },
    key,
  );
}

describe("attestation signing", () => {
  it("round-trips and rejects tampering, wrong protocol, oversized, unsigned", () => {
    const a = att();
    expect(verifyAttestation(a)).toBe(true);
    expect(verifyAttestation({ ...a, wins: 99 })).toBe(false);
    expect(verifyAttestation({ ...a, protocol: "attest/v0" })).toBe(false);
    const { signature: _s, ...unsigned } = a;
    expect(verifyAttestation(unsigned)).toBe(false);
    expect(verifyAttestation({ ...a, model: "x".repeat(9000) })).toBe(false);
    expect(verifyAttestation("nope")).toBe(false);
  });

  it("range-checks every numeric field, rejects unknown keys, hold verdicts, and future clocks", () => {
    // Each of these is SIGNED (a Sybil signs whatever it likes); the range check must still refuse.
    expect(verifyAttestation(att({ losses: -5 }))).toBe(false);
    expect(verifyAttestation(att({ wins: 1.5 }))).toBe(false);
    expect(verifyAttestation(att({ regressions: -1 }))).toBe(false);
    expect(verifyAttestation(att({ p_value: 2 }))).toBe(false);
    expect(verifyAttestation(att({ attested_at: Date.now() + 3600_000 }))).toBe(false);
    expect(verifyAttestation(att({ verdict: "no-capability-tasks" }))).toBe(false);
    expect(verifyAttestation(att({ node_pubkey: "<script>" }))).toBe(false);
    const padded = signAttestation(
      { ...att(), extra: "padding" } as unknown as SkillAttestation,
      KEY,
    );
    expect(verifyAttestation(padded)).toBe(false);
    // Score can never escape [-1, 1] even for a record that slipped past.
    expect(attestationScore({ wins: 10, losses: -5, ties: 0, regressions: 0 })).toBe(1);
  });

  it("scores: any regression is -1, else net win rate", () => {
    expect(attestationScore({ wins: 6, losses: 0, ties: 2, regressions: 0 })).toBeCloseTo(0.75);
    expect(attestationScore({ wins: 10, losses: 0, ties: 0, regressions: 1 })).toBe(-1);
    expect(attestationScore({ wins: 0, losses: 0, ties: 0, regressions: 0 })).toBe(0);
  });
});

describe("attestation store", () => {
  it("newest per attester wins; list returns records", () => {
    const db = new DatabaseSync(":memory:");
    const older = att({ attested_at: 1000, wins: 1 });
    const newer = att({ attested_at: 2000, wins: 5 });
    expect(storeAttestation(db, newer, "local")).toBe(true);
    expect(storeAttestation(db, older, "peer")).toBe(false); // stale
    const list = listAttestations(db, "a".repeat(64));
    expect(list).toHaveLength(1);
    expect(list[0]?.wins).toBe(5);
  });

  it("hold verdicts are never stored as evidence", () => {
    const db = new DatabaseSync(":memory:");
    expect(
      storeAttestation(db, att({ verdict: "no-capability-tasks", wins: 0, ties: 0 }), "local"),
    ).toBe(false);
    expect(storeAttestation(db, att({ verdict: "runner-failed", wins: 0, ties: 0 }), "peer")).toBe(
      false,
    );
    expect(listAttestations(db, "a".repeat(64))).toHaveLength(0);
  });
});

describe("aggregateAttestations (trimmed mean)", () => {
  it("a Sybil ring of low-weight extreme scores cannot drag down trusted evidence", () => {
    const trusted = [0, 1, 2].map(() => att({ wins: 6, losses: 0, ties: 2 }, generateKeyPair()));
    const ring = Array.from({ length: 10 }, () =>
      att(
        { verdict: "regression", wins: 0, losses: 5, ties: 0, regressions: 3 },
        generateKeyPair(),
      ),
    );
    const trustedKeys = new Set(trusted.map((t) => t.attester_pubkey));
    const agg = aggregateAttestations([...ring, ...trusted], (pk) =>
      trustedKeys.has(pk) ? 1 : 0.05,
    );
    // Bounded influence: the ring's collective weight is capped at 25% of
    // the trusted mass (0.75 of 3), so the aggregate stays firmly positive:
    // (3 * 0.75 + 0.5 * -1) / 3.5 = 0.5. Trimming does not engage (< 5
    // trusted attesters) — by design, so the ring cannot activate it.
    expect(agg.score!).toBeCloseTo(0.5, 6);
    expect(agg.attesters).toBe(13);
    expect(agg.unverified).toBe(10);
    expect(agg.regressions).toBe(10);
  });

  it("caps the collective weight of unknown attesters at the default weight (13 minted keys vs 3 trusted)", () => {
    const trusted = [0, 1, 2].map(() => att({ wins: 6, losses: 0, ties: 2 }, generateKeyPair()));
    const ring = Array.from({ length: 13 }, () =>
      att(
        { verdict: "regression", wins: 0, losses: 5, ties: 0, regressions: 3 },
        generateKeyPair(),
      ),
    );
    const trustedKeys = new Set(trusted.map((t) => t.attester_pubkey));
    const agg = aggregateAttestations([...ring, ...trusted], (pk) =>
      trustedKeys.has(pk) ? 1 : DEFAULT_UNKNOWN_ATTESTER_WEIGHT,
    );
    // Ring mass 13 * 0.05 = 0.65 (under the 0.75 cap): (2.25 - 0.65) / 3.65.
    // The cap's worst case with trusted at 0.75 is (0.75 - 0.25) / 1.25 = 0.4.
    expect(agg.score!).toBeCloseTo(1.6 / 3.65, 6);
    expect(agg.score!).toBeGreaterThan(0.4);
    // ...and with no trusted evidence at all there is NO score: unknown-only
    // evidence is exactly what a ring can fabricate for free.
    const only = aggregateAttestations(ring, () => DEFAULT_UNKNOWN_ATTESTER_WEIGHT);
    expect(only.score).toBeNull();
    expect(only.unverified).toBe(13);
  });

  it("trimming is gated on TRUSTED count, so a ring cannot make the band eat trusted mass", () => {
    // Split trusted verdicts (+0.5, -0.6) and a ring of 10 unknowns at +1.
    const t1 = att({ wins: 3, losses: 1, ties: 0 }, generateKeyPair()); // +0.5
    const t2 = att({ wins: 1, losses: 4, ties: 0 }, generateKeyPair()); // -0.6
    const ring = Array.from({ length: 10 }, () =>
      att({ wins: 5, losses: 0, ties: 0 }, generateKeyPair()),
    );
    const trustedKeys = new Set([t1.attester_pubkey, t2.attester_pubkey]);
    const agg = aggregateAttestations([...ring, t1, t2], (pk) =>
      trustedKeys.has(pk) ? 1 : DEFAULT_UNKNOWN_ATTESTER_WEIGHT,
    );
    // No trimming (2 trusted); ring capped to 0.5 mass: (0.5 - 0.6 + 0.5) / 2.5.
    expect(agg.score!).toBeCloseTo(0.16, 6);
    // With >= 5 trusted attesters the band engages and is computed on total weight.
    const five = [0, 1, 2, 3, 4].map(() => att({ wins: 6, losses: 0, ties: 2 }, generateKeyPair()));
    const fiveKeys = new Set(five.map((a) => a.attester_pubkey));
    const trimmed = aggregateAttestations([...ring, ...five], (pk) =>
      fiveKeys.has(pk) ? 1 : DEFAULT_UNKNOWN_ATTESTER_WEIGHT,
    );
    expect(trimmed.score!).toBeCloseTo(0.75, 6);
  });

  it("holds and stale-corpus verdicts are not evidence", () => {
    const measured = att({ wins: 6, losses: 0, ties: 2 }, generateKeyPair());
    const oldGen = att({ corpus_version: "canonical-g2-s1" }, generateKeyPair());
    const agg = aggregateAttestations([measured, oldGen], () => 1, Date.now(), {
      corpusVersionPrefix: "canonical-g3-",
    });
    expect(agg.score).toBeCloseTo(0.75);
    expect(agg.attesters).toBe(1);
    // A hold record that somehow reached the store (older node) is skipped, never scored 0.
    const hold = {
      ...att({}, generateKeyPair()),
      verdict: "no-capability-tasks",
      wins: 0,
      ties: 0,
    };
    expect(aggregateAttestations([measured, hold], () => 1).score).toBeCloseTo(0.75);
  });

  it("zero-weight (banned) attesters are ignored; stale evidence is ignored; none = null", () => {
    const banned = att({}, generateKeyPair());
    const stale = att({ attested_at: Date.now() - 200 * 24 * 3600 * 1000 }, generateKeyPair());
    expect(aggregateAttestations([banned], () => 0).score).toBeNull();
    expect(aggregateAttestations([stale], () => 1).score).toBeNull();
    expect(aggregateAttestations([], () => 1).score).toBeNull();
  });
});

describe("rescoreSkill + sweep", () => {
  async function writeCorpus(
    configDir: string,
    opts: { capability: number; regression?: number },
  ): Promise<void> {
    const wiki = path.join(configDir, "skill-wiki");
    await fs.mkdir(wiki, { recursive: true });
    const lines = Array.from({ length: opts.capability }, (_, k) => k + 1).map((i) =>
      JSON.stringify({
        id: `cap-${i}`,
        prompt: `cap task ${i}. Reply "FINAL: <answer>".`,
        checker: { kind: "final", value: `ok-${i}` },
        suite: "capability",
      }),
    );
    for (let i = 1; i <= (opts.regression ?? 0); i += 1) {
      lines.push(
        JSON.stringify({
          id: `reg-${i}`,
          prompt: `reg task ${i}. Reply "FINAL: <answer>".`,
          checker: { kind: "final", value: `reg-ok-${i}` },
          suite: "regression",
        }),
      );
    }
    await fs.writeFile(path.join(wiki, "task-corpus.jsonl"), `${lines.join("\n")}\n`);
  }

  async function tmpConfig(withCapability: boolean): Promise<string> {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "attest-"));
    if (withCapability) {
      await writeCorpus(configDir, { capability: 6 });
    }
    return configDir;
  }

  /** Fake agent: canonical tasks always right; capability tasks right only when the skill is injected. */
  const agentTurn = async (prompt: string) => {
    const capMatch = /cap task (\d+)/.exec(prompt);
    if (capMatch) {
      return prompt.includes("SKILL-MARKER") ? `FINAL: ok-${capMatch[1]}` : "FINAL: wrong";
    }
    // Grown regression tasks: the incumbent passes; a skill carrying
    // BREAKS-BASELINE makes the candidate fail them (a real regression).
    const regMatch = /reg task (\d+)/.exec(prompt);
    if (regMatch) {
      return prompt.includes("BREAKS-BASELINE") ? "FINAL: broken" : `FINAL: reg-ok-${regMatch[1]}`;
    }
    // Canonical tasks carry their expected value nowhere in the prompt; answer
    // by echoing a FINAL line the checker cannot match — regression-neutral
    // because both arms behave identically.
    return "FINAL: same-for-both-arms";
  };

  it("attests a skill that wins the private capability suite; regression-neutral on canonical", async () => {
    const configDir = await tmpConfig(true);
    const db = new DatabaseSync(":memory:");
    const res = await rescoreSkill({
      content: "# Skill\nSKILL-MARKER: do the cap tasks right.",
      agentTurn,
      keyPair: KEY,
      storeOpts: { configDir },
      trialsPerTask: 2,
      db,
    });
    const a = res.attestation;
    expect(a).not.toBeNull();
    expect(a!.verdict).toBe("accepted");
    expect(a!.wins).toBe(6);
    expect(a!.regressions).toBe(0);
    expect(a!.private_suite_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyAttestation(a)).toBe(true);
    expect(listAttestations(db, a!.content_sha256)).toHaveLength(1);
  });

  it("holds (no capability tasks) on a fresh node without spending rollouts or signing evidence", async () => {
    const configDir = await tmpConfig(false);
    const db = new DatabaseSync(":memory:");
    let calls = 0;
    const res = await rescoreSkill({
      content: "# Skill",
      agentTurn: async () => {
        calls += 1;
        return "FINAL: x";
      },
      keyPair: KEY,
      storeOpts: { configDir },
      db,
    });
    expect(res.verdict).toBe("no-capability-tasks");
    expect(res.attestation).toBeNull();
    expect(calls).toBe(0);
    expect(listAttestations(db, skillContentSha256("# Skill"))).toHaveLength(0);
  });

  it("signs a -1 regression verdict when the skill breaks tasks the incumbent passes", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "attest-"));
    await writeCorpus(configDir, { capability: 6, regression: 3 });
    const db = new DatabaseSync(":memory:");
    const res = await rescoreSkill({
      content: "# Skill\nSKILL-MARKER BREAKS-BASELINE",
      agentTurn,
      keyPair: KEY,
      storeOpts: { configDir },
      trialsPerTask: 1,
      db,
    });
    expect(res.attestation?.verdict).toBe("regression");
    expect(res.attestation!.regressions).toBeGreaterThan(0);
    expect(attestationScore(res.attestation!)).toBe(-1);
    expect(verifyAttestation(res.attestation)).toBe(true);
  });

  function seedPeerSkills(
    db: DatabaseSync,
    skills: Array<{ id: string; peer: string; text?: string }>,
  ) {
    ensureMemoryIndexSchema({ db, embeddingCacheTable: "ec", ftsTable: "fts", ftsEnabled: false });
    ensureColumn(db, "chunks", "semantic_type", "TEXT");
    ensureColumn(db, "chunks", "governance_json", "TEXT");
    let t = 1000;
    for (const sk of skills) {
      db.prepare(
        `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, semantic_type, governance_json)
         VALUES (?, ?, 'memory', 0, 0, ?, 'test', ?, '[]', ?, 'skill', ?)`,
      ).run(
        sk.id,
        `s/${sk.id}`,
        `h-${sk.id}`,
        sk.text ?? `# ${sk.id}\nSKILL-MARKER`,
        (t += 1),
        JSON.stringify({ peerOrigin: sk.peer }),
      );
    }
  }

  it("sweep attests unattested peer-origin skills, bounded per pass, one per peer, skipping attested ones", async () => {
    const configDir = await tmpConfig(true);
    const db = new DatabaseSync(":memory:");
    seedPeerSkills(db, [
      { id: "p1", peer: "pk-a" },
      { id: "p2", peer: "pk-a" },
      { id: "p3", peer: "pk-b" },
    ]);
    const base = { db, agentTurn, keyPair: KEY, storeOpts: { configDir }, trialsPerTask: 1 };
    const first = await runAttestationSweep({ ...base, maxPerPass: 3 });
    // pk-a's second skill waits for the next pass (round-robin by author).
    expect(first).toEqual({ attested: 2, skipped: 1, held: 0 });
    const second = await runAttestationSweep({ ...base, maxPerPass: 3 });
    expect(second).toEqual({ attested: 1, skipped: 2, held: 0 });
    const mine = pubkeyId(KEY);
    const count = db
      .prepare(`SELECT COUNT(*) c FROM skill_attestations WHERE attester_pubkey = ?`)
      .get(mine) as { c: number };
    expect(count.c).toBe(3);
    expect(skillContentSha256("# p1\nSKILL-MARKER")).toMatch(/^[0-9a-f]{64}$/);
    // Nothing changed: a third pass measures nothing.
    expect((await runAttestationSweep({ ...base, maxPerPass: 3 })).attested).toBe(0);
  });

  it("re-attests when the private suite changes; short-circuits with no capability suite", async () => {
    const configDir = await tmpConfig(true);
    const db = new DatabaseSync(":memory:");
    seedPeerSkills(db, [{ id: "p1", peer: "pk-a" }]);
    const base = { db, agentTurn, keyPair: KEY, storeOpts: { configDir }, trialsPerTask: 1 };
    expect((await runAttestationSweep(base)).attested).toBe(1);
    expect((await runAttestationSweep(base)).skipped).toBe(1);
    await writeCorpus(configDir, { capability: 7 });
    expect((await runAttestationSweep(base)).attested).toBe(1);

    const fresh = await tmpConfig(false);
    let calls = 0;
    const r = await runAttestationSweep({
      db,
      agentTurn: async () => {
        calls += 1;
        return "FINAL: x";
      },
      keyPair: KEY,
      storeOpts: { configDir: fresh },
    });
    expect(r).toEqual({ attested: 0, skipped: 0, held: 0 });
    expect(calls).toBe(0);
  });

  it("never executes peer text the injection scanner flags", async () => {
    const configDir = await tmpConfig(true);
    const db = new DatabaseSync(":memory:");
    seedPeerSkills(db, [{ id: "evil", peer: "pk-z", text: "# evil\nSKILL-MARKER EVIL" }]);
    let calls = 0;
    const r = await runAttestationSweep({
      db,
      agentTurn: async (p) => {
        calls += 1;
        return agentTurn(p);
      },
      keyPair: KEY,
      storeOpts: { configDir },
      scan: (t) => ({ severity: t.includes("EVIL") ? "critical" : "ok" }),
    });
    expect(r).toEqual({ attested: 0, skipped: 0, held: 1 });
    expect(calls).toBe(0);
  });
});
