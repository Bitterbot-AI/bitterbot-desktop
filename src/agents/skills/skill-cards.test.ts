import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../../commerce/envelope.js";
import {
  SKILL_CARD_LIMITS,
  type CellRecords,
  exportSkillCards,
  importSkillCards,
  peerEvidenceFor,
  peerEvidenceText,
} from "./skill-cards.js";

const h = (c: string) => c.repeat(64);
const NOW = 1_800_000_000_000;
const accepted = (n = 1) => ({ passed: n, runs: n });
const rejected = (n = 1) => ({ passed: 0, runs: n });

describe("skill card bundles", () => {
  const key = generateKeyPair();
  const cells: CellRecords = { default: { [h("a")]: accepted(3), [h("b")]: rejected(2) } };

  it("round-trips a signed bundle that names no skill", () => {
    const bundle = exportSkillCards({ cells, key, now: NOW })!;
    expect(bundle.origin).toBe(`ed25519:${key.publicKeyHex}`);
    expect(JSON.stringify(bundle)).not.toMatch(/name/);
    const res = importSkillCards(JSON.parse(JSON.stringify(bundle)), { now: NOW + 1000 });
    expect(res.ok && res.bundle.cells).toEqual(cells);
  });

  it("exports nothing when nothing is verified", () => {
    expect(exportSkillCards({ cells: {}, key, now: NOW })).toBeNull();
    expect(
      exportSkillCards({ cells: { default: { [h("a")]: { passed: 0, runs: 0 } } }, key, now: NOW }),
    ).toBeNull();
    expect(
      exportSkillCards({ cells: { default: { nothash: accepted() } }, key, now: NOW }),
    ).toBeNull();
  });

  it("refuses a bundle whose counts, origin or dates were changed after signing", () => {
    const bundle = exportSkillCards({ cells, key, now: NOW })!;
    const flipped = structuredClone(bundle);
    flipped.cells.default![h("b")] = accepted(2);
    expect(importSkillCards(flipped, { now: NOW })).toEqual({ ok: false, reason: "bad signature" });
    const stolen = { ...bundle, origin: `ed25519:${generateKeyPair().publicKeyHex}` };
    expect(importSkillCards(stolen, { now: NOW })).toEqual({ ok: false, reason: "bad signature" });
    const extended = { ...bundle, issuedAt: bundle.issuedAt + 5 };
    expect(importSkillCards(extended, { now: NOW + 10 }).ok).toBe(false);
  });

  it("refuses expired, post-dated, own, oversized and malformed bundles", () => {
    const bundle = exportSkillCards({ cells, key, now: NOW })!;
    expect(importSkillCards(bundle, { now: NOW + SKILL_CARD_LIMITS.ttlMs }).ok).toBe(false);
    expect(importSkillCards(bundle, { now: NOW - SKILL_CARD_LIMITS.skewMs - 1 }).ok).toBe(false);
    expect(importSkillCards(bundle, { now: NOW, self: bundle.origin })).toEqual({
      ok: false,
      reason: "own bundle",
    });
    expect(importSkillCards({ ...bundle, extra: 1 }, { now: NOW }).ok).toBe(false);
    expect(importSkillCards(null, { now: NOW }).ok).toBe(false);
    expect(
      importSkillCards({ ...bundle, cells: { default: { x: accepted() } } }, { now: NOW }).ok,
    ).toBe(false);
    expect(
      importSkillCards(
        { ...bundle, cells: { default: { [h("a")]: { passed: 3, runs: 2 } } } },
        { now: NOW },
      ).ok,
    ).toBe(false);
  });

  it("keeps the most-used records when a ledger exceeds the limits, and clamps counts", () => {
    const big: CellRecords = { default: {} };
    for (let i = 0; i < 400; i++) {
      big.default![i.toString(16).padStart(64, "0")] = accepted(i + 1);
    }
    big.default![h("f")] = { passed: 4_000, runs: 5_000 };
    const bundle = exportSkillCards({ cells: big, key, now: NOW })!;
    const recs = bundle.cells.default!;
    expect(Object.keys(recs)).toHaveLength(SKILL_CARD_LIMITS.maxRecords);
    expect(recs[h("f")]).toEqual({ passed: 800, runs: 1_000 });
    expect(recs[(399).toString(16).padStart(64, "0")]).toEqual(accepted(400));
    expect(recs[(0).toString(16).padStart(64, "0")]).toBeUndefined();
    expect(JSON.stringify(bundle).length).toBeLessThanOrEqual(SKILL_CARD_LIMITS.maxBytes);
    expect(importSkillCards(bundle, { now: NOW }).ok).toBe(true);
  });

  it("never turns a mixed record into a unanimous one when clamping", () => {
    const bundle = exportSkillCards({
      cells: {
        default: {
          [h("a")]: { passed: 1, runs: 5_000 },
          [h("b")]: { passed: 4_999, runs: 5_000 },
          [h("c")]: { passed: 0, runs: 5_000 },
          [h("d")]: { passed: 5_000, runs: 5_000 },
        },
      },
      key,
      now: NOW,
    })!;
    expect(bundle.cells.default).toEqual({
      [h("a")]: { passed: 1, runs: 1_000 },
      [h("b")]: { passed: 999, runs: 1_000 },
      [h("c")]: { passed: 0, runs: 1_000 },
      [h("d")]: { passed: 1_000, runs: 1_000 },
    });
  });

  it("sheds records until a bundle with long cell names fits the size peers accept", () => {
    const big: CellRecords = {};
    for (let c = 0; c < 16; c++) {
      const cell = `${"x".repeat(110)}-${c}`;
      big[cell] = {};
      for (let i = 0; i < 9; i++) {
        big[cell]![(c * 16 + i).toString(16).padStart(64, "0")] = accepted(c * 16 + i + 1);
      }
    }
    const bundle = exportSkillCards({ cells: big, key, now: NOW })!;
    expect(JSON.stringify(bundle).length).toBeLessThanOrEqual(SKILL_CARD_LIMITS.maxBytes);
    expect(importSkillCards(bundle, { now: NOW }).ok).toBe(true);
  });
});

describe("peer evidence for a cell", () => {
  const A = h("a");
  const B = h("b");
  const C = h("c");
  const acc = (agree: number, voters = agree) => ({ verdict: "accepted", agree, voters });
  const rej = (agree: number, voters = agree) => ({ verdict: "rejected", agree, voters });

  it("shows a verdict only when a quorum of peers agrees and outnumbers the dissent", () => {
    const one = peerEvidenceFor({
      own: {},
      peers: [{ default: { [A]: accepted() } }],
      cell: "default",
    });
    expect(one.verdicts).toEqual({});
    const two = peerEvidenceFor({
      own: {},
      peers: [
        { default: { [A]: accepted(5) } },
        { default: { [A]: accepted(1), [B]: rejected() } },
      ],
      cell: "default",
    });
    expect(two.verdicts).toEqual({ [A]: acc(2) });
    const split = peerEvidenceFor({
      own: {},
      peers: [
        { default: { [A]: accepted() } },
        { default: { [A]: accepted() } },
        { default: { [A]: rejected() } },
        { default: { [A]: rejected() } },
      ],
      cell: "default",
    });
    expect(split.verdicts).toEqual({});
  });

  it("gives each peer one vote however many runs it claims, and reports the dissent", () => {
    const res = peerEvidenceFor({
      own: {},
      peers: [
        { default: { [A]: rejected(1_000) } },
        { default: { [A]: accepted() } },
        { default: { [A]: accepted() } },
      ],
      cell: "default",
    });
    expect(res.verdicts).toEqual({ [A]: acc(2, 3) });
    expect(peerEvidenceText(res.verdicts[A]!)).toBe(
      "Reports from other agents here: ACCEPTED by 2 of 3 other agents that tried it.",
    );
    expect(peerEvidenceText({ verdict: "rejected", agree: 1, voters: 1 })).toBe(
      "Reports from other agents here: REJECTED by the 1 other agent that tried it.",
    );
  });

  it("counts a mixed record by its majority and lets an even split abstain", () => {
    const res = peerEvidenceFor({
      own: {},
      peers: [
        { default: { [A]: { passed: 1, runs: 10 }, [B]: { passed: 1, runs: 2 } } },
        { default: { [A]: rejected(), [B]: accepted() } },
      ],
      cell: "default",
    });
    expect(res.verdicts).toEqual({ [A]: rej(2) });
  });

  it("leaves out skills the recipient has tried itself in the cell", () => {
    const res = peerEvidenceFor({
      own: { default: { [A]: rejected() } },
      peers: [
        { default: { [A]: accepted(), [B]: accepted() } },
        { default: { [A]: accepted(), [B]: accepted() } },
      ],
      cell: "default",
    });
    expect(res.verdicts).toEqual({ [B]: acc(2) });
  });

  const own: CellRecords = {
    c1: { [A]: accepted() },
    c2: { [A]: accepted() },
    c3: { [A]: accepted() },
    c4: {},
  };
  const honest: CellRecords = { c1: { [A]: accepted() }, c4: { [C]: rejected() } };

  it("drops a peer whose records keep contradicting the recipient's own outcomes", () => {
    const liar: CellRecords = {
      c1: { [A]: rejected() },
      c2: { [A]: rejected() },
      c3: { [A]: rejected() },
      c4: { [C]: accepted() },
    };
    const res = peerEvidenceFor({ own, peers: [liar, honest, honest], cell: "c4" });
    expect(res.dropped).toBe(1);
    expect(res.verdicts).toEqual({ [C]: rej(2) });
    // Known limit: with no own outcomes to check against, two colluding signers meet a quorum of two.
    const unguarded = peerEvidenceFor({ own: {}, peers: [liar, liar, honest], cell: "c4" });
    expect(unguarded.verdicts).toEqual({ [C]: acc(2, 3) });
  });

  it("checks a peer on the same position it votes with, so near-unanimous records cannot dodge the guard", () => {
    const almost = { passed: 1, runs: 1_000 };
    const dodger: CellRecords = {
      c1: { [A]: almost },
      c2: { [A]: almost },
      c3: { [A]: almost },
      c4: { [C]: { passed: 999, runs: 1_000 } },
    };
    const res = peerEvidenceFor({ own, peers: [dodger, dodger, honest, honest], cell: "c4" });
    expect(res.dropped).toBe(2);
    expect(res.verdicts).toEqual({ [C]: rej(2) });
  });

  it("uses only the requested cell", () => {
    const res = peerEvidenceFor({
      own: {},
      peers: [{ other: { [A]: accepted() } }, { other: { [A]: accepted() } }],
      cell: "default",
    });
    expect(res.verdicts).toEqual({});
  });
});
